# agent-wechat on Render (free Web Service)
# Runs the native agent-wechat daemon (Rust, no GUI) + a tiny public proxy.
# The daemon only binds loopback, so the proxy exposes /health on $PORT.
#
# Base: Debian 12 (glibc 2.36+) as required by the wx binary; Node 24.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
# The wx binary (verified by SHA256 below) lives here; the CLI launcher uses it.
ENV AGENT_WECHAT_NATIVE_BINARY=/opt/agent-wechat/wx
ENV DAEMON_PORT=6174

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# --- agent-wechat native binary v2.2.0 (Linux x64, GNU) ---
# Verified SHA256 (from wx-v2.2.0-checksums.json in the v2.2.0 GitHub release):
# 0b59f03ace18358d0606df1eb15e0495016aabe07208da8c45dc785b70de93b3
ARG WX_VERSION=2.2.0
ARG WX_SHA256=0b59f03ace18358d0606df1eb15e0495016aabe07208da8c45dc785b70de93b3
RUN mkdir -p /opt/agent-wechat \
    && curl -fsSL -o /opt/agent-wechat/wx \
         "https://github.com/thisnick/agent-wechat/releases/download/v${WX_VERSION}/wx-v${WX_VERSION}-linux-x64-gnu" \
    && echo "${WX_SHA256}  /opt/agent-wechat/wx" | sha256sum -c - \
    && chmod +x /opt/agent-wechat/wx

# --- agent-wechat CLI (npm launcher; uses the pre-verified binary, no download) ---
RUN npm install -g --allow-scripts=@agent-wechat/cli @agent-wechat/cli@${WX_VERSION} \
    && wx --json version

WORKDIR /app
COPY package.json proxy.js bot.js start.sh ./
RUN chmod +x start.sh \
    && node --check proxy.js \
    && node --check bot.js

# Render sets $PORT at runtime; EXPOSE is documentary.
EXPOSE 10000

CMD ["bash", "/app/start.sh"]
