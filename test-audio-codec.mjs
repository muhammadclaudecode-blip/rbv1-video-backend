import assert from "node:assert/strict";
import { analyzePcm16, encodeAudioFrames, decodeAudioFrames, SAMPLE_RATE } from "./audio-analysis.mjs";

function pcmFrom(fn, seconds = 1) {
  const out = Buffer.alloc(Math.floor(SAMPLE_RATE * seconds) * 2);
  let seed = 123456789;
  for (let i = 0; i < out.length / 2; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const value = fn(i / SAMPLE_RATE, i, seed / 0xffffffff * 2 - 1);
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2);
  }
  return out;
}

const signals = {
  silence: () => 0,
  sweep: (t) => 0.5 * Math.sin(2 * Math.PI * (100 + 900 * t) * t),
  chord: (t) => 0.2 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 330 * t) + Math.sin(2 * Math.PI * 440 * t)),
  impulse: (_t, i) => i % 2205 === 0 ? 0.9 : 0,
  speechLike: (t) => (0.3 + 0.2 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * (120 + 20 * Math.sin(2 * Math.PI * 2 * t)) * t),
  noise: (_t, _i, random) => random * 0.4,
};

for (const [name, signal] of Object.entries(signals)) {
  const frames = analyzePcm16(pcmFrom(signal), { duration: 1 });
  const first = encodeAudioFrames(frames), second = encodeAudioFrames(frames);
  assert.deepEqual(first.chunks, second.chunks, `${name}: output must be deterministic`);
  const decoded = decodeAudioFrames(first);
  assert.equal(decoded.length, frames.length);
  const corrupted = { ...first, chunks: first.chunks.map((x) => Buffer.from(x)) };
  const entry = first.manifest.frames[0]; corrupted.chunks[entry.chunk - 1][entry.offset + 13] ^= 1;
  assert.throws(() => decodeAudioFrames(corrupted), /CRC mismatch/);
  console.log(`${name}: ${frames.length} frames, ${first.manifest.totalBytes} bytes, round-trip/CRC/determinism OK`);
}
