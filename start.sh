#!/bin/bash
# Start the agent-wechat daemon + the public proxy for Render.
# The daemon only listens on loopback (127.0.0.1:6174); the proxy binds
# 0.0.0.0:$PORT so Render's router / health check can reach the service.
set -u

export AGENT_WECHAT_NATIVE_BINARY="${AGENT_WECHAT_NATIVE_BINARY:-/opt/agent-wechat/wx}"
DAEMON_PORT="${DAEMON_PORT:-6174}"
# Data dir: default is ~/.local/share/agent-wechat. Pin it explicitly so
# the daemon and the proxy (which reads the owner token from the same dir)
# always agree, even if HOME differs between processes.
export AGENT_WECHAT_DATA_DIR="${AGENT_WECHAT_DATA_DIR:-$HOME/.local/share/agent-wechat}"
DATA_DIR_ARGS=(--data-dir "$AGENT_WECHAT_DATA_DIR")

# Keep the daemon alive: restart it if it ever exits.
(
  while true; do
    echo "[start] launching wx serve on 127.0.0.1:${DAEMON_PORT} ..."
    wx serve "${DATA_DIR_ARGS[@]}" --listen "127.0.0.1:${DAEMON_PORT}"
    echo "[start] daemon exited (code $?), restarting in 5s ..."
    sleep 5
  done
) &
DAEMON_LOOP_PID=$!

# Wait for the daemon to become healthy (up to ~60s) before starting the proxy.
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${DAEMON_PORT}/health" >/dev/null 2>&1; then
    echo "[start] daemon is healthy"
    break
  fi
  sleep 2
done

# Reply bot (bot.js): polls the daemon on loopback and answers the group
# via SiliconFlow. Needs SILICONFLOW_API_KEY in the environment; if it is
# missing the bot stays up and logs a warning instead of crashing.
(
  while true; do
    echo "[start] launching bot.js ..."
    node /app/bot.js
    echo "[start] bot exited (code $?), restarting in 5s ..."
    sleep 5
  done
) &
BOT_LOOP_PID=$!

# Proxy in the foreground: this is the container's main process.
# If the proxy dies, Render restarts the container (and the daemon with it).
exec node /app/proxy.js
