import fs from "node:fs";
import path from "node:path";
import { crc32, MAX_CHUNK_BYTES } from "./rbv1.mjs";

export const AUDIO_FPS = 30;
export const SAMPLE_RATE = 22050;
export const FFT_SIZE = 2048;
export const TONE_COUNT = 256;
export const NOISE_COUNT = 64;
const MIN_HZ = 40;
const MAX_HZ = 10500;
const HEADER_SIZE = 24;
const RECORD_HEADER_SIZE = 13;

function fft(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const wr0 = Math.cos(angle), wi0 = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const even = start + j, odd = even + len / 2;
        const tr = wr * real[odd] - wi * imag[odd];
        const ti = wr * imag[odd] + wi * real[odd];
        real[odd] = real[even] - tr; imag[odd] = imag[even] - ti;
        real[even] += tr; imag[even] += ti;
        const nextWr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0; wr = nextWr;
      }
    }
  }
}

function percentile(values, p) {
  if (!values.length) return 1;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * p))] || 1;
}

export function analyzePcm16(pcm, { duration = pcm.length / 2 / SAMPLE_RATE } = {}) {
  const sampleCount = Math.floor(pcm.length / 2);
  const frameCount = Math.max(1, Math.min(Math.ceil(duration * AUDIO_FPS), Math.ceil(sampleCount * AUDIO_FPS / SAMPLE_RATE)));
  const hop = SAMPLE_RATE / AUDIO_FPS;
  const window = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1));
  const minBin = Math.ceil(MIN_HZ * FFT_SIZE / SAMPLE_RATE);
  const maxBin = Math.floor(MAX_HZ * FFT_SIZE / SAMPLE_RATE);
  const bandEdges = new Uint16Array(NOISE_COUNT + 1);
  for (let i = 0; i <= NOISE_COUNT; i++) bandEdges[i] = Math.round(minBin * Math.pow(maxBin / minBin, i / NOISE_COUNT));
  const rawFrames = [];
  const toneLevels = [], noiseLevels = [];
  let previousSlots = new Array(TONE_COUNT).fill(null);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const center = Math.round(frameIndex * hop);
    const real = new Float64Array(FFT_SIZE), imag = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      const sampleIndex = center + i - FFT_SIZE / 2;
      real[i] = (sampleIndex >= 0 && sampleIndex < sampleCount ? pcm.readInt16LE(sampleIndex * 2) / 32768 : 0) * window[i];
    }
    fft(real, imag);
    const magnitudes = new Float64Array(maxBin + 1);
    for (let b = minBin; b <= maxBin; b++) magnitudes[b] = Math.hypot(real[b], imag[b]) / (FFT_SIZE / 2);
    const peaks = [];
    for (let b = minBin + 1; b < maxBin; b++) {
      const m = magnitudes[b];
      if (m > magnitudes[b - 1] && m >= magnitudes[b + 1] && m > 1e-5) {
        const a = Math.log(magnitudes[b - 1] + 1e-12), c = Math.log(magnitudes[b + 1] + 1e-12), mid = Math.log(m + 1e-12);
        const denom = a - 2 * mid + c;
        const offset = denom ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denom)) : 0;
        peaks.push({ bin: b, hz: (b + offset) * SAMPLE_RATE / FFT_SIZE, level: m });
      }
    }
    peaks.sort((a, b) => b.level - a.level);
    peaks.length = Math.min(TONE_COUNT, peaks.length);
    const slots = new Array(TONE_COUNT).fill(null), used = new Uint8Array(TONE_COUNT);
    for (const peak of peaks) {
      let best = -1, bestDistance = 0.08;
      for (let slot = 0; slot < TONE_COUNT; slot++) if (!used[slot] && previousSlots[slot]) {
        const distance = Math.abs(Math.log(peak.hz / previousSlots[slot].hz));
        if (distance < bestDistance) { bestDistance = distance; best = slot; }
      }
      if (best < 0) for (let slot = 0; slot < TONE_COUNT; slot++) if (!used[slot] && !previousSlots[slot]) { best = slot; break; }
      if (best < 0) for (let slot = 0; slot < TONE_COUNT; slot++) if (!used[slot]) { best = slot; break; }
      slots[best] = peak; used[best] = 1;
    }
    const selectedBins = new Uint8Array(maxBin + 1);
    for (const peak of peaks) {
      for (let d = -1; d <= 1; d++) if (peak.bin + d >= 0) selectedBins[peak.bin + d] = 1;
      toneLevels.push(peak.level);
    }
    const noise = new Float64Array(NOISE_COUNT);
    for (let band = 0; band < NOISE_COUNT; band++) {
      let energy = 0, count = 0;
      const lo = bandEdges[band], hi = Math.max(lo + 1, bandEdges[band + 1]);
      for (let b = lo; b < hi && b <= maxBin; b++) if (!selectedBins[b]) { energy += magnitudes[b] ** 2; count++; }
      noise[band] = count ? Math.sqrt(energy / count) : 0;
      noiseLevels.push(noise[band]);
    }
    rawFrames.push({ peaks: slots, noise });
    previousSlots = slots;
  }
  const toneScale = percentile(toneLevels, 0.995) * 1.25;
  const noiseScale = percentile(noiseLevels, 0.995) * 2;
  return rawFrames.map(({ peaks, noise }) => {
    const tones = new Array(TONE_COUNT);
    for (let i = 0; i < TONE_COUNT; i++) {
      const peak = peaks[i];
      const amplitude = peak ? Math.round(255 * Math.sqrt(Math.min(1, peak.level / toneScale))) : 0;
      tones[i] = { frequency: peak ? Math.max(MIN_HZ, Math.min(MAX_HZ, peak.hz)) : MIN_HZ, amplitude: amplitude < 3 ? 0 : amplitude };
    }
    const noiseAmplitudes = Array.from(noise, (level) => {
      const value = Math.round(255 * Math.sqrt(Math.min(1, level / noiseScale)));
      return value < 3 ? 0 : value;
    });
    return { tones, noise: noiseAmplitudes };
  });
}

export function quantizeFrequency(hz) {
  return Math.round(65535 * Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ));
}

export function dequantizeFrequency(value) {
  return MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, value / 65535);
}

function denseFrame(frame) {
  const out = Buffer.alloc(TONE_COUNT * 3 + NOISE_COUNT);
  for (let i = 0; i < TONE_COUNT; i++) {
    out.writeUInt16LE(quantizeFrequency(frame.tones[i].frequency), i * 3);
    out[i * 3 + 2] = frame.tones[i].amplitude;
  }
  for (let i = 0; i < NOISE_COUNT; i++) out[TONE_COUNT * 3 + i] = frame.noise[i];
  return out;
}

function deltaFrame(previous, current) {
  const maskBytes = TONE_COUNT / 8 + NOISE_COUNT / 8;
  const changed = [];
  const masks = Buffer.alloc(maskBytes);
  for (let i = 0; i < TONE_COUNT; i++) {
    const o = i * 3;
    if (previous[o] !== current[o] || previous[o + 1] !== current[o + 1] || previous[o + 2] !== current[o + 2]) {
      masks[i >> 3] |= 1 << (i & 7); changed.push(current.subarray(o, o + 3));
    }
  }
  const noiseOffset = TONE_COUNT * 3;
  for (let i = 0; i < NOISE_COUNT; i++) if (previous[noiseOffset + i] !== current[noiseOffset + i]) {
    masks[TONE_COUNT / 8 + (i >> 3)] |= 1 << (i & 7); changed.push(current.subarray(noiseOffset + i, noiseOffset + i + 1));
  }
  return Buffer.concat([masks, ...changed]);
}

function makeHeader(frameCount, keyframeInterval) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write("RBA1", 0, "ascii"); header.writeUInt16LE(AUDIO_FPS, 4); header.writeUInt32LE(frameCount, 6);
  header.writeUInt16LE(TONE_COUNT, 10); header.writeUInt16LE(NOISE_COUNT, 12); header.writeUInt16LE(keyframeInterval, 14);
  header.writeUInt32LE(SAMPLE_RATE, 16); header.writeUInt32LE(crc32(header.subarray(0, 20)), 20);
  return header;
}

function makeRecord(index, type, payload) {
  const record = Buffer.alloc(RECORD_HEADER_SIZE + payload.length);
  record[0] = type; record.writeUInt32LE(index, 1); record.writeUInt32LE(payload.length, 5); record.writeUInt32LE(crc32(payload), 9);
  payload.copy(record, RECORD_HEADER_SIZE); return record;
}

export function encodeAudioFrames(frames, { keyframeInterval = 60 } = {}) {
  if (!frames.length) throw new Error("No audio analysis frames");
  const chunks = [], entries = [];
  let parts = [makeHeader(frames.length, keyframeInterval)], size = HEADER_SIZE, previous;
  const flush = () => { if (size) chunks.push(Buffer.concat(parts)); parts = []; size = 0; };
  for (let i = 0; i < frames.length; i++) {
    const dense = denseFrame(frames[i]), type = i % keyframeInterval === 0 ? 0 : 1;
    const payload = type === 0 ? dense : deltaFrame(previous, dense);
    const record = makeRecord(i, type, payload);
    if (record.length > MAX_CHUNK_BYTES) throw new Error(`Audio frame ${i} exceeds chunk limit`);
    if (size + record.length > MAX_CHUNK_BYTES) flush();
    const offset = size; parts.push(record); size += record.length;
    entries.push({ chunk: chunks.length + 1, offset, length: record.length, type }); previous = dense;
  }
  flush();
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return { chunks, manifest: { magic: "RBA1", fps: AUDIO_FPS, frameCount: frames.length, toneCount: TONE_COUNT, noiseCount: NOISE_COUNT, keyframeInterval, sampleRate: SAMPLE_RATE, duration: frames.length / AUDIO_FPS, totalBytes, frames: entries } };
}

export function decodeAudioFrames(encoded) {
  const result = [], denseLength = TONE_COUNT * 3 + NOISE_COUNT;
  let previous;
  for (const entry of encoded.manifest.frames) {
    const record = encoded.chunks[entry.chunk - 1].subarray(entry.offset, entry.offset + entry.length);
    const payloadLength = record.readUInt32LE(5), payload = record.subarray(RECORD_HEADER_SIZE, RECORD_HEADER_SIZE + payloadLength);
    if (crc32(payload) !== record.readUInt32LE(9)) throw new Error("RBA1 CRC mismatch");
    let dense;
    if (record[0] === 0) { if (payload.length !== denseLength) throw new Error("Invalid RBA1 keyframe"); dense = Buffer.from(payload); }
    else {
      dense = Buffer.from(previous); let cursor = TONE_COUNT / 8 + NOISE_COUNT / 8;
      for (let i = 0; i < TONE_COUNT; i++) if (payload[i >> 3] & (1 << (i & 7))) { payload.copy(dense, i * 3, cursor, cursor + 3); cursor += 3; }
      for (let i = 0; i < NOISE_COUNT; i++) if (payload[TONE_COUNT / 8 + (i >> 3)] & (1 << (i & 7))) { dense[TONE_COUNT * 3 + i] = payload[cursor++]; }
      if (cursor !== payload.length) throw new Error("Invalid RBA1 delta");
    }
    result.push(dense); previous = dense;
  }
  return result;
}

function luaManifest(m, sineAssetId, noiseAssetId) {
  const index = Buffer.alloc(m.frames.length * 11);
  m.frames.forEach((frame, i) => {
    const offset = i * 11;
    index.writeUInt16LE(frame.chunk, offset); index.writeUInt32LE(frame.offset, offset + 2);
    index.writeUInt32LE(frame.length, offset + 6); index.writeUInt8(frame.type, offset + 10);
  });
  return `return {\n\tmagic="RBA1",fps=${m.fps},frameCount=${m.frameCount},toneCount=${m.toneCount},noiseCount=${m.noiseCount},keyframeInterval=${m.keyframeInterval},sampleRate=${m.sampleRate},duration=${m.duration},totalBytes=${m.totalBytes},sineAssetId=${Number(sineAssetId) || 0},noiseAssetId=${Number(noiseAssetId) || 0},\n\tframeIndex="${index.toString("base64")}",\n}\n`;
}

export function writeAudioPackage(clipDir, encoded, { sineAssetId = 0, noiseAssetId = 0 } = {}) {
  const audioDir = path.join(clipDir, "Audio"), chunksDir = path.join(audioDir, "Chunks");
  fs.mkdirSync(chunksDir, { recursive: true });
  encoded.chunks.forEach((chunk, i) => fs.writeFileSync(path.join(chunksDir, `AudioChunk${String(i + 1).padStart(4, "0")}.lua`), `return "${chunk.toString("base64")}"\n`));
  fs.writeFileSync(path.join(audioDir, "Manifest.lua"), luaManifest(encoded.manifest, sineAssetId, noiseAssetId));
  fs.writeFileSync(path.join(audioDir, "manifest.json"), JSON.stringify({ ...encoded.manifest, chunks: encoded.chunks.length, sineAssetId: Number(sineAssetId) || 0, noiseAssetId: Number(noiseAssetId) || 0 }, null, 2));
}
