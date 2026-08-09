FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg gnupg \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Cloudflare's official Linux client. The entrypoint uses its local-proxy mode,
# so only yt-dlp traffic is tunneled and the web server remains directly reachable.
RUN curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
       | gpg --dearmor --yes -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main" \
       > /etc/apt/sources.list.d/cloudflare-client.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends cloudflare-warp \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp's recommended proof-of-origin provider for cloud/datacenter IPs.
RUN mkdir -p /root/.config/yt-dlp/plugins \
    && curl -fsSL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip \
       -o /root/.config/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip \
    && curl -fsSL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/1.3.1.tar.gz \
       | tar -xz -C /root \
    && mv /root/bgutil-ytdlp-pot-provider-1.3.1 /root/bgutil-ytdlp-pot-provider \
    && cd /root/bgutil-ytdlp-pot-provider/server \
    && npm ci \
    && npx tsc

WORKDIR /app
COPY . .
RUN chmod 0755 /app/start-backend.sh
ENV HOST=0.0.0.0 NODE_ENV=production
EXPOSE 10000
CMD ["/app/start-backend.sh"]
