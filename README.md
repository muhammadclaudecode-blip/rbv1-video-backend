# Roblox RBV1/RBA1 Video Importer

Imports a complete HTTPS YouTube video as a synchronized
EditableImage video and compact additive-resynthesis control data. The source
audio is decoded temporarily to mono 22.05 kHz PCM, analyzed locally, and
deleted with the temporary download. The song and source video are never
uploaded to Roblox.

Requirements: Node.js 20+, FFmpeg, and yt-dlp from their official releases or
WinGet. The verified local toolchain is Node.js 24.19.0, Gyan FFmpeg 9.0, and
yt-dlp 2026.07.04.

## Required one-time audio assets

The `assets` folder contains two generated, reusable files:

- `rbv1-sine-440.wav`
- `rbv1-white-noise.wav`

Upload only these two WAVs through Studio's Asset Manager, wait for moderation,
and grant the current experience permission if Roblox marks either asset
restricted. Copy their numeric asset IDs. You must own or have permission for
the URL's audio.

Restart Studio once so it loads the updated hidden importer relay, then press
Play. A centered `StarterGui.VideoImporterGui` panel accepts the URL and both
asset IDs. The single in-game button runs download, RBV1 encoding, 30 Hz
FFT/RBA1 analysis, and MCP installation into the Edit place. Stop and restart
Play after completion to load the new clip.

The importer ScreenGui disables itself outside Studio. The MCP token and local
tool access remain inside the plugin relay and are never copied into game
scripts or published clients.

The in-world screen includes per-viewer YouTube-style controls: play/pause,
restart, 10-second back/forward, click-or-drag seeking, 0.25x through 2x
playback speed, mute, volume, progress, and elapsed/total time. Keyboard
shortcuts are Space/K, J/L, Left/Right, M, Home, and Up/Down. A viewer's
controls do not change playback for other players.

The command-line equivalent is:

```powershell
node import-video.mjs --url "https://www.youtube.com/watch?v=..." --output .\ImportedVideo --sine-asset-id 123 --noise-asset-id 456
node install-into-studio.mjs .\ImportedVideo "place:78229903663647"
```

Defaults are the full video, 256x144, and 15 video FPS. A combined 20 MiB
safety limit rejects videos that are too large for practical Roblox place
embedding; `--duration <seconds>` can still make a shorter import. Audio analysis uses a
2048-sample Hann FFT at 30 control FPS, 256 tracked tonal voices, and 64
logarithmic noise bands. Playlists, cookies, user config, subtitles,
thumbnails, arbitrary post-processors, and runtime HTTP are disabled.

The installer talks only to the authenticated Roblox Studio MCP bridge on
`127.0.0.1`. Enable **Allow Mesh / Image APIs** in **Game Settings > Security**
for EditableImage playback.

## Live in-game importing

`hosted-backend.mjs` and the included `Dockerfile` expose a provider-neutral
HTTPS backend contract. The in-game importer now calls this backend through a
server-only `VideoImporterRelay`. When a job finishes, the Roblox server
fetches compact manifests and <=96 KiB binary chunks, caches them, relays them
to connected clients, and increments `LiveClipRevision`. Video and audio swap
in the already-running client; Play does not need to restart.

For local Studio testing, start the backend with:

```powershell
$env:RBV1_API_KEY="dev-local-key"
node hosted-backend.mjs
```

The installed `ServerScriptService.VideoBackendConfig` points Studio at
`http://127.0.0.1:8787`. After deploying the Docker image, set
`LiveBackendUrl` to its HTTPS origin, create a Roblox experience secret named
`RBV1_BACKEND_API_KEY` with the same value as the host's `RBV1_API_KEY`, and
enable **Allow HTTP Requests**. The API key and outbound HTTP access remain on
the Roblox server and are never replicated to clients.

The backend keeps completed clips temporarily and removes them after one hour
by default. Override `RBV1_JOB_TTL_MS` if needed. `RBV1_TEST_DURATION_SECONDS`
exists only for short deployment smoke tests; leave it unset for full videos.
