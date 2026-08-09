#!/bin/sh
set -u

WARP_PROXY="socks5://127.0.0.1:40000"
WARP_TRACE="https://www.cloudflare.com/cdn-cgi/trace"

log() {
  printf '%s\n' "[warp] $*"
}

start_warp() {
  if ! command -v warp-svc >/dev/null 2>&1 || ! command -v warp-cli >/dev/null 2>&1; then
    log "Cloudflare WARP is not installed; YouTube requests will use the normal Render route."
    return 1
  fi

  mkdir -p /var/lib/cloudflare-warp /var/log/cloudflare-warp
  warp-svc >/tmp/warp-svc.log 2>&1 &

  ready=0
  attempts=0
  while [ "$attempts" -lt 20 ]; do
    if warp-cli --accept-tos status >/dev/null 2>&1; then
      ready=1
      break
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    log "The WARP daemon did not become ready; continuing without it."
    tail -n 20 /tmp/warp-svc.log 2>/dev/null || true
    return 1
  fi

  warp-cli --accept-tos registration new >/tmp/warp-registration.log 2>&1 || true
  warp-cli --accept-tos tunnel protocol set MASQUE >/tmp/warp-protocol.log 2>&1 || true

  # Current releases expose these as `mode proxy` and `proxy port`. If a
  # future client changes them, failure is detected by the trace check below.
  if ! warp-cli --accept-tos mode proxy >/tmp/warp-mode.log 2>&1; then
    log "Could not enable local-proxy mode; continuing without WARP."
    cat /tmp/warp-mode.log 2>/dev/null || true
    return 1
  fi
  warp-cli --accept-tos proxy port 40000 >/tmp/warp-port.log 2>&1 || true
  if ! warp-cli --accept-tos connect >/tmp/warp-connect.log 2>&1; then
    log "Could not connect WARP; continuing without it."
    cat /tmp/warp-connect.log 2>/dev/null || true
    return 1
  fi

  attempts=0
  while [ "$attempts" -lt 25 ]; do
    trace=$(curl -fsS --max-time 8 --proxy "$WARP_PROXY" "$WARP_TRACE" 2>/dev/null || true)
    if printf '%s\n' "$trace" | grep -q '^warp=on$'; then
      export RBV1_YTDLP_PROXY="$WARP_PROXY"
      log "Connected. yt-dlp traffic will use Cloudflare WARP local proxy."
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done

  log "WARP proxy verification failed; continuing over Render's normal route."
  warp-cli --accept-tos status 2>/dev/null || true
  tail -n 20 /tmp/warp-svc.log 2>/dev/null || true
  return 1
}

start_warp || true
exec node hosted-backend.mjs
