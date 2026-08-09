import fs from "node:fs";
import path from "node:path";

export const MAX_CHUNK_BYTES = 96 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const HEADER_SIZE = 20;
export const RECORD_HEADER_SIZE = 13;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function rgb24To332(rgb) {
  const pixels = Buffer.allocUnsafe(rgb.length / 3);
  for (let src = 0, dst = 0; src < rgb.length; src += 3, dst++) {
    pixels[dst] = (rgb[src] & 0xe0) | ((rgb[src + 1] & 0xe0) >>> 3) | ((rgb[src + 2] & 0xc0) >>> 6);
  }
  return pixels;
}

export function rgb332ToRgba(indices) {
  const rgba = Buffer.allocUnsafe(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    const r = (v >>> 5) & 7;
    const g = (v >>> 2) & 7;
    const b = v & 3;
    const o = i * 4;
    rgba[o] = Math.round(r * 255 / 7);
    rgba[o + 1] = Math.round(g * 255 / 7);
    rgba[o + 2] = Math.round(b * 255 / 3);
    rgba[o + 3] = 255;
  }
  return rgba;
}

export function packBitsEncode(input) {
  const out = [];
  let i = 0;
  while (i < input.length) {
    let run = 1;
    while (i + run < input.length && input[i + run] === input[i] && run < 130) run++;
    if (run >= 3) {
      out.push(0x80 | (run - 3), input[i]);
      i += run;
      continue;
    }
    const start = i;
    i += run;
    while (i < input.length && i - start < 128) {
      run = 1;
      while (i + run < input.length && input[i + run] === input[i] && run < 3) run++;
      if (run >= 3) break;
      i += run;
    }
    const length = i - start;
    out.push(length - 1, ...input.subarray(start, i));
  }
  return Buffer.from(out);
}

export function packBitsDecode(input, expectedLength) {
  const out = Buffer.allocUnsafe(expectedLength);
  let src = 0, dst = 0;
  while (src < input.length && dst < expectedLength) {
    const control = input[src++];
    if (control < 0x80) {
      const count = control + 1;
      input.copy(out, dst, src, src + count);
      src += count;
      dst += count;
    } else {
      const count = (control & 0x7f) + 3;
      out.fill(input[src++], dst, dst + count);
      dst += count;
    }
  }
  if (dst !== expectedLength || src !== input.length) throw new Error("Invalid PackBits payload");
  return out;
}

function pushVarint(out, value) {
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
}

function readVarint(input, state) {
  let value = 0, shift = 0;
  while (state.offset < input.length && shift <= 28) {
    const byte = input[state.offset++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return value >>> 0;
    shift += 7;
  }
  throw new Error("Invalid varint");
}

export function deltaEncode(previous, current) {
  const out = [];
  let position = 0;
  while (position < current.length) {
    let skip = 0;
    while (position + skip < current.length && previous[position + skip] === current[position + skip]) skip++;
    pushVarint(out, skip);
    position += skip;
    const start = position;
    while (position < current.length && previous[position] !== current[position]) position++;
    const literal = position - start;
    pushVarint(out, literal);
    for (let i = start; i < position; i++) out.push(current[i]);
  }
  return Buffer.from(out);
}

export function deltaDecode(previous, payload) {
  const out = Buffer.from(previous);
  const state = { offset: 0 };
  let position = 0;
  while (position < out.length) {
    position += readVarint(payload, state);
    const literal = readVarint(payload, state);
    if (position + literal > out.length || state.offset + literal > payload.length) throw new Error("Invalid delta payload");
    payload.copy(out, position, state.offset, state.offset + literal);
    state.offset += literal;
    position += literal;
  }
  if (state.offset !== payload.length) throw new Error("Trailing delta bytes");
  return out;
}

function makeHeader({ width, height, fps, frameCount, keyframeInterval }) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write("RBV1", 0, "ascii");
  header.writeUInt16LE(width, 4);
  header.writeUInt16LE(height, 6);
  header.writeUInt16LE(fps, 8);
  header.writeUInt32LE(frameCount, 10);
  header.writeUInt16LE(keyframeInterval, 14);
  header.writeUInt32LE(crc32(header.subarray(0, 16)), 16);
  return header;
}

function makeRecord(frameIndex, type, payload) {
  const record = Buffer.allocUnsafe(RECORD_HEADER_SIZE + payload.length);
  record.writeUInt8(type, 0);
  record.writeUInt32LE(frameIndex, 1);
  record.writeUInt32LE(payload.length, 5);
  record.writeUInt32LE(crc32(payload), 9);
  payload.copy(record, RECORD_HEADER_SIZE);
  return record;
}

function encodeFrameSequence(frameCount, getFrame, options) {
  const { width, height, fps, keyframeInterval = fps * 2 } = options;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  if (!frameCount) throw new Error("No frames to encode");
  const chunks = [];
  const frames = [];
  let currentParts = [makeHeader({ width, height, fps, frameCount, keyframeInterval })];
  let currentSize = HEADER_SIZE;
  let previous = null;
  const flush = () => {
    if (!currentParts.length) return;
    chunks.push(Buffer.concat(currentParts));
    currentParts = [];
    currentSize = 0;
  };

  for (let i = 0; i < frameCount; i++) {
    const indexed = getFrame(i);
    const isKeyframe = i % keyframeInterval === 0;
    const payload = isKeyframe ? packBitsEncode(indexed) : deltaEncode(previous, indexed);
    const type = isKeyframe ? 0 : 1;
    const record = makeRecord(i, type, payload);
    if (record.length > MAX_CHUNK_BYTES) throw new Error(`Frame ${i} exceeds the chunk limit`);
    if (currentSize + record.length > MAX_CHUNK_BYTES) flush();
    const offset = currentSize;
    currentParts.push(record);
    currentSize += record.length;
    frames.push({ chunk: chunks.length + 1, offset, length: record.length, type });
    previous = indexed;
  }
  flush();
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (totalBytes > maxTotalBytes) throw new Error(`Encoded payload is ${(totalBytes / 1048576).toFixed(1)} MiB; shorten the clip or lower FPS (${(maxTotalBytes / 1048576).toFixed(0)} MiB maximum)`);
  return { chunks, manifest: { magic: "RBV1", width, height, fps, frameCount, keyframeInterval, duration: frameCount / fps, totalBytes, frames } };
}

export function encodeFrames(indexedFrames, options) {
  return encodeFrameSequence(indexedFrames.length, (index) => indexedFrames[index], options);
}

export function encodeRgb24File(filePath, frameCount, options) {
  const rgbBytes = options.width * options.height * 3;
  const rgb = Buffer.allocUnsafe(rgbBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    return encodeFrameSequence(frameCount, (index) => {
      const bytesRead = fs.readSync(fd, rgb, 0, rgbBytes, index * rgbBytes);
      if (bytesRead !== rgbBytes) throw new Error(`Incomplete RGB frame ${index}`);
      return rgb24To332(rgb);
    }, options);
  } finally {
    fs.closeSync(fd);
  }
}

function luaManifest(manifest) {
  const index = Buffer.alloc(manifest.frames.length * 11);
  manifest.frames.forEach((frame, i) => {
    const offset = i * 11;
    index.writeUInt16LE(frame.chunk, offset); index.writeUInt32LE(frame.offset, offset + 2);
    index.writeUInt32LE(frame.length, offset + 6); index.writeUInt8(frame.type, offset + 10);
  });
  return `return {\n\tmagic="RBV1",\n\twidth=${manifest.width},\n\theight=${manifest.height},\n\tfps=${manifest.fps},\n\tframeCount=${manifest.frameCount},\n\tkeyframeInterval=${manifest.keyframeInterval},\n\tduration=${manifest.duration},\n\ttotalBytes=${manifest.totalBytes},\n\tframeIndex="${index.toString("base64")}",\n}\n`;
}

export function writePackage(outputDir, encoded, metadata = {}) {
  if (fs.existsSync(outputDir)) throw new Error(`Output directory already exists: ${outputDir}`);
  const chunksDir = path.join(outputDir, "Chunks");
  fs.mkdirSync(chunksDir, { recursive: true });
  encoded.chunks.forEach((chunk, index) => {
    fs.writeFileSync(path.join(chunksDir, `Chunk${String(index + 1).padStart(4, "0")}.lua`), `return "${chunk.toString("base64")}"\n`);
  });
  fs.writeFileSync(path.join(outputDir, "Manifest.lua"), luaManifest(encoded.manifest));
  fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify({ ...encoded.manifest, ...metadata, chunks: encoded.chunks.length }, null, 2));
}
