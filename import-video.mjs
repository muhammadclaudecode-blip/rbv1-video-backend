#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { encodeRgb24File, writePackage } from "./rbv1.mjs";
import { analyzePcm16, encodeAudioFrames, writeAudioPackage } from "./audio-analysis.mjs";

function parseArgs(argv) {
  const options = { start: 0, duration: "full", width: 256, height: 144, fps: 15, maxTotalMib: 20 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === "help") options.help = true;
    else options[key] = argv[++i];
  }
  for (const key of ["start", "width", "height", "fps", "maxTotalMib"]) options[key] = Number(options[key]);
  if (options.duration !== "full") options.duration = Number(options.duration);
  return options;
}

function usage() {
  console.log("import-video --url <youtube-url> --output <directory> [--sine-asset-id <id> --noise-asset-id <id>] [--start 0 --duration full --width 256 --height 144 --fps 15 --max-total-mib 20]");
  console.log("             --input <local-video> may be used instead of --url");
}

function youtubeVideoId(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let id = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] || null;
  } else {
    id = url.searchParams.get("v");
    if (!id) id = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1] || null;
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id || "")) {
    throw new Error("Invalid YouTube video ID. It must be exactly 11 characters; copy the URL again from YouTube.");
  }
  return id;
}

function validate(options) {
  if (options.help) return;
  if ((!options.url && !options.input) || (options.url && options.input)) throw new Error("Provide exactly one of --url or --input");
  if (!options.output) throw new Error("--output is required");
  if (options.url) {
    const url = new URL(options.url);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.protocol !== "https:" || !["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) throw new Error("Only HTTPS youtube.com or youtu.be URLs are accepted");
    youtubeVideoId(url);
  }
  if (!Number.isFinite(options.start) || options.start < 0) throw new Error("--start must be non-negative");
  if (options.duration !== "full" && (!Number.isFinite(options.duration) || options.duration <= 0)) throw new Error("--duration must be a positive number or 'full'");
  if (![options.width, options.height, options.fps].every(Number.isInteger)) throw new Error("Width, height, and FPS must be integers");
  if (options.width < 16 || options.height < 16 || options.width > 512 || options.height > 512 || options.fps < 1 || options.fps > 30) throw new Error("Dimensions must be 16..512 and FPS 1..30");
  if (!Number.isFinite(options.maxTotalMib) || options.maxTotalMib < 1 || options.maxTotalMib > 256) throw new Error("--max-total-mib must be between 1 and 256");
}

function findFile(root, wanted, depth = 0) {
  if (!root || depth > 6 || !fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === wanted.toLowerCase()) return fullPath;
    if (entry.isDirectory()) {
      const found = findFile(fullPath, wanted, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findExecutable(explicit, names, wingetPackagePrefix) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`Executable not found: ${explicit}`);
    return explicit;
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const linksRoot = path.join(localAppData, "Microsoft", "WinGet", "Links");
    for (const name of names) {
      const linked = path.join(linksRoot, name);
      if (fs.existsSync(linked)) return linked;
    }
    const packagesRoot = path.join(localAppData, "Microsoft", "WinGet", "Packages");
    if (fs.existsSync(packagesRoot)) {
      for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(wingetPackagePrefix)) continue;
        for (const name of names) {
          const found = findFile(path.join(packagesRoot, entry.name), name);
          if (found) return found;
        }
      }
    }
  }
  const where = process.platform === "win32"
    ? path.join(process.env.WINDIR || "C:\\Windows", "System32", "where.exe")
    : "which";
  for (const name of names) {
    const probe = spawnSync(where, [name], { encoding: "utf8" });
    if (probe.status === 0) return probe.stdout.trim().split(/\r?\n/)[0];
  }
  throw new Error(`Could not find ${names[0]}; install it from WinGet or pass its explicit path`);
}

function findOptionalExecutable(explicit, names, wingetPackagePrefix) {
  try {
    return findExecutable(explicit, names, wingetPackagePrefix);
  } catch {
    return null;
  }
}

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function toolVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true });
  return (result.stdout || result.stderr || "unknown").split(/\r?\n/)[0].trim();
}

const options = parseArgs(process.argv.slice(2));
try {
  validate(options);
  if (options.help) { usage(); process.exit(0); }
  const ffmpeg = findExecutable(options.ffmpeg, ["ffmpeg.exe", "ffmpeg"], "Gyan.FFmpeg_");
  const ytdlp = options.url ? findExecutable(options.ytdlp, ["yt-dlp.exe", "yt-dlp"], "yt-dlp.yt-dlp_") : null;
  const deno = options.url ? findOptionalExecutable(options.deno, ["deno.exe", "deno"], "DenoLand.Deno_") : null;
  const fallbackAcquisitionFfmpeg = options.url
    ? findOptionalExecutable(options.acquisitionFfmpeg, ["ffmpeg.exe"], "yt-dlp.FFmpeg_") || ffmpeg
    : null;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rbv1-import-"));
  try {
    let inputPath = options.input ? path.resolve(options.input) : null;
    let transcodeStart = options.start;
    if (options.url) {
      const template = path.join(tempDir, "source.%(ext)s");
      const clientProfiles = ["tv_simply", "android_vr", "visionos", "web_safari", "mweb"];
      const makeAcquisitionArgs = (ffmpegPath, playerClient) => {
        const args = [
          "--ignore-config", "--no-playlist", "--no-cache-dir", "--no-cookies",
          "--no-write-comments", "--no-write-thumbnail", "--no-write-subs", "--no-color", "--newline",
          "--force-ipv4", "--socket-timeout", "10", "--retries", "3", "--fragment-retries", "3", "--extractor-retries", "3",
          "--extractor-args", "youtubetab:skip=webpage",
          "--extractor-args", `youtube:player_skip=webpage,configs;player_client=${playerClient}`,
          "--extractor-args", "youtubepot-bgutilscript:server_home=/root/bgutil-ytdlp-pot-provider/server",
          "--concurrent-fragments", "4",
          "--progress-template", "download:[download] %(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s",
          "--ffmpeg-location", path.dirname(ffmpegPath),
          "--max-filesize", "250M",
          "-f", "bestvideo[height<=360][vcodec^=avc1]+bestaudio/bestvideo[height<=360]+bestaudio/best[height<=360]", "--merge-output-format", "mp4", "-o", template, options.url,
        ];
        if (options.duration !== "full") args.splice(args.indexOf("-f"), 0, "--download-sections", `*${options.start}-${options.start + options.duration}`);
        if (deno) args.unshift("--js-runtimes", `deno:${deno}`);
        else args.unshift("--js-runtimes", "node");
        return args;
      };
      const clearAcquisitionFiles = () => {
        for (const name of fs.readdirSync(tempDir)) fs.rmSync(path.join(tempDir, name), { recursive: true, force: true });
      };
      const acquireWithFreshUrls = (ffmpegPath, label, profiles) => {
        let lastError;
        for (let attempt = 1; attempt <= profiles.length; attempt++) {
          try {
            run(ytdlp, makeAcquisitionArgs(ffmpegPath, profiles[attempt - 1]), label);
            return;
          } catch (error) {
            lastError = error;
            if (attempt < profiles.length) {
              clearAcquisitionFiles();
              console.warn(`${label} failed with ${profiles[attempt - 1]}; trying ${profiles[attempt]} (attempt ${attempt + 1}/${profiles.length}).`);
            }
          }
        }
        throw lastError;
      };
      try {
        acquireWithFreshUrls(ffmpeg, "yt-dlp", clientProfiles);
      } catch (primaryError) {
        if (!fallbackAcquisitionFfmpeg || fallbackAcquisitionFfmpeg === ffmpeg) throw primaryError;
        clearAcquisitionFiles();
        console.warn("Primary FFmpeg acquisition failed; retrying with yt-dlp's bundled FFmpeg build.");
        acquireWithFreshUrls(fallbackAcquisitionFfmpeg, "yt-dlp fallback", clientProfiles);
      }
      inputPath = fs.readdirSync(tempDir).map((name) => path.join(tempDir, name)).find((file) => path.basename(file).startsWith("source."));
      if (!inputPath) throw new Error("yt-dlp did not produce a video file");
      transcodeStart = 0;
    } else if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);

    const rawPath = path.join(tempDir, "frames.rgb");
    const pcmPath = path.join(tempDir, "audio.pcm");
    const filter = `fps=${options.fps},scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2:black`;
    const durationArgs = options.duration === "full" ? [] : ["-t", String(options.duration)];
    run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(transcodeStart), ...durationArgs, "-i", inputPath, "-an", "-vf", filter, "-pix_fmt", "rgb24", "-f", "rawvideo", rawPath], "FFmpeg");
    run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(transcodeStart), ...durationArgs, "-i", inputPath, "-vn", "-ac", "1", "-ar", "22050", "-f", "s16le", pcmPath], "FFmpeg audio extraction");

    const frameBytes = options.width * options.height * 3;
    const frameCount = Math.floor(fs.statSync(rawPath).size / frameBytes);
    if (!frameCount) throw new Error("FFmpeg produced no complete frames");
    const maxTotalBytes = Math.floor(options.maxTotalMib * 1024 * 1024);
    const encoded = encodeRgb24File(rawPath, frameCount, { ...options, maxTotalBytes });
    writePackage(path.resolve(options.output), encoded, {
      source: options.url ? options.url : path.basename(inputPath),
      start: options.start,
      requestedDuration: options.duration,
      ffmpegVersion: toolVersion(ffmpeg),
      ytdlpVersion: ytdlp ? toolVersion(ytdlp) : null,
      audio: true,
    });
    const pcm = fs.readFileSync(pcmPath);
    const audioDuration = pcm.length / 2 / 22050;
    const audioFrames = analyzePcm16(pcm, { duration: audioDuration });
    const audioEncoded = encodeAudioFrames(audioFrames);
    if (encoded.manifest.totalBytes + audioEncoded.manifest.totalBytes > maxTotalBytes) {
      throw new Error(`Combined video/audio payload is ${((encoded.manifest.totalBytes + audioEncoded.manifest.totalBytes) / 1048576).toFixed(1)} MiB; shorten the clip or lower FPS (${options.maxTotalMib} MiB maximum)`);
    }
    writeAudioPackage(path.resolve(options.output), audioEncoded, { sineAssetId: options.sineAssetId, noiseAssetId: options.noiseAssetId });
    console.log(`Encoded ${frameCount} video frames into ${encoded.chunks.length} chunks (${(encoded.manifest.totalBytes / 1048576).toFixed(2)} MiB)`);
    console.log(`Analyzed ${audioFrames.length} audio frames into ${audioEncoded.chunks.length} RBA1 chunks (${(audioEncoded.manifest.totalBytes / 1024).toFixed(1)} KiB)`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`import-video: ${error.message}`);
  usage();
  process.exit(1);
}
