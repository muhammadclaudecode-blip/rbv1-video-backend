import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deltaDecode, deltaEncode, encodeFrames, encodeRgb24File, packBitsDecode, packBitsEncode, rgb24To332, rgb332ToRgba } from "./rbv1.mjs";

const patterns = [
  Buffer.alloc(1024, 7),
  Buffer.from(Array.from({ length: 1024 }, (_, i) => i & 255)),
  Buffer.from(Array.from({ length: 1024 }, (_, i) => (i % 31) < 12 ? 55 : i & 255)),
];
for (const pattern of patterns) assert.deepEqual(packBitsDecode(packBitsEncode(pattern), pattern.length), pattern);

const previous = Buffer.from(Array.from({ length: 4096 }, (_, i) => i & 255));
const current = Buffer.from(previous);
current.fill(9, 200, 450);
current.fill(18, 3000, 3300);
assert.deepEqual(deltaDecode(previous, deltaEncode(previous, current)), current);

const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
const indexed = rgb24To332(rgb);
assert.equal(indexed.length, 3);
assert.equal(rgb332ToRgba(indexed).length, 12);

const frames = [Buffer.alloc(256, 1), Buffer.alloc(256, 1), Buffer.alloc(256, 2), Buffer.alloc(256, 2)];
frames[1][42] = 9;
const encoded = encodeFrames(frames, { width: 16, height: 16, fps: 2, keyframeInterval: 2 });
assert.equal(encoded.manifest.frameCount, 4);
assert.equal(encoded.manifest.frames[0].type, 0);
assert.equal(encoded.manifest.frames[1].type, 1);
assert.equal(encoded.manifest.frames[2].type, 0);

const rgbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rbv1-stream-test-")), "frames.rgb");
try {
  const rgbFrames = frames.map((frame) => Buffer.from(Array.from(frame).flatMap((value) => [value & 0xe0, (value & 0x1c) << 3, (value & 3) << 6])));
  fs.writeFileSync(rgbFile, Buffer.concat(rgbFrames));
  const streamed = encodeRgb24File(rgbFile, frames.length, { width: 16, height: 16, fps: 2, keyframeInterval: 2 });
  assert.deepEqual(streamed.manifest.frames, encoded.manifest.frames);
  assert.deepEqual(streamed.chunks, encoded.chunks);
} finally {
  fs.rmSync(path.dirname(rgbFile), { recursive: true, force: true });
}

const corrupted = Buffer.from(frames[0]);
const before = crc32(corrupted);
corrupted[0] ^= 1;
assert.notEqual(crc32(corrupted), before);
console.log("RBV1 codec tests passed");
