#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

const root = import.meta.dirname;
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const apiKey = process.env.RBV1_API_KEY || (process.env.NODE_ENV === "production" ? "" : "dev-local-key");
if (!apiKey) throw new Error("RBV1_API_KEY is required in production");
const workRoot = path.resolve(process.env.RBV1_JOB_DIR || path.join(os.tmpdir(), "rbv1-hosted-jobs"));
const ttlMs = Math.max(5 * 60_000, Number(process.env.RBV1_JOB_TTL_MS || 60 * 60_000));
const testDuration = Number(process.env.RBV1_TEST_DURATION_SECONDS || 0);
const jobs = new Map();
const QUALITY_PROFILES = new Set(["256x144", "320x180", "384x216"]);
const FRAME_RATES = new Set([15, 24, 30]);

fs.mkdirSync(workRoot, { recursive: true });

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

function authorized(req) {
  const provided = req.headers["x-api-key"];
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided), b = Buffer.from(apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function bodyJson(req) {
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > 16 * 1024) throw new Error("Request body is too large");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}

function validateUrl(value) {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (parsed.protocol !== "https:" || !["youtube.com", "m.youtube.com", "youtu.be"].includes(hostname)) {
    throw new Error("Only HTTPS youtube.com and youtu.be URLs are accepted");
  }
  let videoId = null;
  if (hostname === "youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] || null;
  } else {
    videoId = parsed.searchParams.get("v");
    if (!videoId) videoId = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1] || null;
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) {
    throw new Error("Invalid YouTube video ID. It must be exactly 11 characters; copy the URL again from YouTube.");
  }
  return parsed.href;
}

function runImporter(job, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "import-video.mjs"), ...args], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.pid = child.pid;
    const append = (chunk) => {
      const text = chunk.toString("utf8");
      job.output = (job.output + text).slice(-16_000);
      const progress = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("[download]")).at(-1);
      if (progress) job.message = progress;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Importer exited with code ${code}`)));
  });
}

function compactManifest(file) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(manifest.frames) || !Number.isInteger(manifest.frameCount) || manifest.frames.length !== manifest.frameCount) {
    throw new Error("Invalid clip manifest");
  }
  const index = Buffer.alloc(manifest.frames.length * 11);
  manifest.frames.forEach((frame, i) => {
    const offset = i * 11;
    index.writeUInt16LE(frame.chunk, offset);
    index.writeUInt32LE(frame.offset, offset + 2);
    index.writeUInt32LE(frame.length, offset + 6);
    index.writeUInt8(frame.type, offset + 10);
  });
  const { frames, chunks, ...rest } = manifest;
  return { ...rest, chunkCount: chunks, frameIndex: index.toString("base64") };
}

function clipManifest(job) {
  const clip = path.join(job.directory, "ImportedVideo");
  return {
    clipId: job.clipId,
    video: compactManifest(path.join(clip, "manifest.json")),
    audio: compactManifest(path.join(clip, "Audio", "manifest.json")),
  };
}

function chunkData(job, kind, index) {
  if (!Number.isInteger(index) || index < 1 || index > 10_000) throw new Error("Invalid chunk index");
  const clip = path.join(job.directory, "ImportedVideo");
  const file = kind === "audio"
    ? path.join(clip, "Audio", "Chunks", `AudioChunk${String(index).padStart(4, "0")}.lua`)
    : path.join(clip, "Chunks", `Chunk${String(index).padStart(4, "0")}.lua`);
  const source = fs.readFileSync(file, "utf8");
  const match = source.match(/^return\s+"([A-Za-z0-9+/=]+)"\s*$/);
  if (!match) throw new Error("Invalid chunk file");
  return match[1];
}

async function startJob(payload) {
  if ([...jobs.values()].some((job) => ["queued", "processing"].includes(job.phase))) {
    throw Object.assign(new Error("Another import is already running"), { status: 409 });
  }
  const url = validateUrl(String(payload.url || ""));
  const sineAssetId = String(payload.sineAssetId || "").replace(/\D/g, "");
  const noiseAssetId = String(payload.noiseAssetId || "").replace(/\D/g, "");
  if (!/^[1-9]\d*$/.test(sineAssetId) || !/^[1-9]\d*$/.test(noiseAssetId)) throw new Error("Valid oscillator asset IDs are required");
  const width = Number(payload.width ?? 384);
  const height = Number(payload.height ?? 216);
  const fps = Number(payload.fps ?? 30);
  if (!QUALITY_PROFILES.has(`${width}x${height}`)) throw new Error("Quality must be 144p, 180p, or 216p");
  if (!FRAME_RATES.has(fps)) throw new Error("Frame rate must be 15, 24, or 30 FPS");
  const profileScale = (width * height) / (384 * 216) * (fps / 30);
  const maxTotalMib = Math.max(80, Math.ceil(180 * profileScale));
  const id = randomUUID();
  const directory = path.join(workRoot, id);
  fs.mkdirSync(directory, { recursive: true });
  const job = { id, clipId: id, directory, width, height, fps, phase: "queued", message: "Queued", output: "", createdAt: Date.now(), updatedAt: Date.now() };
  jobs.set(id, job);
  void (async () => {
    try {
      job.phase = "processing";
      job.message = "Downloading and encoding...";
      const importerArgs = [
        "--url", url,
        "--output", path.join(directory, "ImportedVideo"),
        "--start", "0", "--width", String(width), "--height", String(height), "--fps", String(fps),
        "--max-total-mib", String(maxTotalMib), "--temporal-threshold", "1",
        "--sine-asset-id", sineAssetId, "--noise-asset-id", noiseAssetId,
      ];
      if (Number.isFinite(testDuration) && testDuration > 0) importerArgs.push("--duration", String(testDuration));
      await runImporter(job, importerArgs);
      job.phase = "complete";
      job.message = "Ready";
    } catch (error) {
      job.phase = "error";
      const useful = job.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-4).join(" ");
      if (/Sign in to confirm you.re not a bot|This video is unavailable\. Error code: 152/i.test(job.output)) {
        job.message = "YouTube blocked this cloud server for that video. Try again later or use another public video; account cookies and untrusted proxy services are intentionally disabled.";
      } else {
        job.message = `${error.message}${useful ? `: ${useful}` : ""}`;
      }
    } finally {
      job.updatedAt = Date.now();
      delete job.pid;
    }
  })();
  return job;
}

function publicJob(job) {
  return { jobId: job.id, phase: job.phase, message: job.message, width: job.width, height: job.height, fps: job.fps, clipId: job.phase === "complete" ? job.clipId : undefined };
}

setInterval(() => {
  const cutoff = Date.now() - ttlMs;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff && !["queued", "processing"].includes(job.phase)) {
      fs.rmSync(job.directory, { recursive: true, force: true });
      jobs.delete(id);
    }
  }
}, 60_000).unref();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok", service: "rbv1-video-backend" });
    if (!authorized(req)) return json(res, 401, { error: "Unauthorized" });
    if (req.method === "POST" && url.pathname === "/v1/jobs") {
      const job = await startJob(await bodyJson(req));
      return json(res, 202, publicJob(job));
    }
    let match = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)$/);
    if (req.method === "GET" && match) {
      const job = jobs.get(match[1]);
      return job ? json(res, 200, publicJob(job)) : json(res, 404, { error: "Job not found" });
    }
    match = url.pathname.match(/^\/v1\/clips\/([0-9a-f-]+)\/manifest$/);
    if (req.method === "GET" && match) {
      const job = jobs.get(match[1]);
      if (!job || job.phase !== "complete") return json(res, 404, { error: "Clip not found" });
      return json(res, 200, clipManifest(job));
    }
    match = url.pathname.match(/^\/v1\/clips\/([0-9a-f-]+)\/(video|audio)\/(\d+)$/);
    if (req.method === "GET" && match) {
      const job = jobs.get(match[1]);
      if (!job || job.phase !== "complete") return json(res, 404, { error: "Clip not found" });
      return json(res, 200, { data: chunkData(job, match[2], Number(match[3])) });
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, error.status || 400, { error: error.message || String(error) });
  }
});

server.listen(port, host, () => console.log(`RBV1 hosted backend listening on http://${host}:${port}`));
