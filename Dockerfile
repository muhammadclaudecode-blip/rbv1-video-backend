FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
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
ENV HOST=0.0.0.0 NODE_ENV=production
EXPOSE 10000
CMD ["node", "hosted-backend.mjs"]
