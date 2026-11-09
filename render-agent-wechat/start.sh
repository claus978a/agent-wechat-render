#!/bin/bash
# Start the agent-wechat daemon + the public proxy for Render.
# The daemon only listens on loopback (127.0.0.1:6174); the proxy binds
# 0.0.0.0:$PORT so Render's router / health check can reach the service.
set -u

export AGENT_WECHAT_NATIVE_BINARY="${AGENT_WECHAT_NATIVE_BINARY:-/opt/agent-wechat/wx}"
DAEMON_PORT="${DAEMON_PORT:-6174}"
# Optional: override the daemon data dir (default: ~/.local/share/agent-wechat).
# Set AGENT_WECHAT_DATA_DIR to test without touching the real profile.
DATA_DIR_ARGS=()
if [ -n "${AGENT_WECHAT_DATA_DIR:-}" ]; then
  DATA_DIR_ARGS=(--data-dir "$AGENT_WECHAT_DATA_DIR")
fi

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

# Proxy in the foreground: this is the container's main process.
# If the proxy dies, Render restarts the container (and the daemon with it).
exec node /app/proxy.js
