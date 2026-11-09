#!/bin/bash
# Watch new WeChat events (messages) as JSON lines, resumable via a cursor file.
# Run this in the Render Shell (or any terminal where `wx` can reach the daemon).
# It prints one JSON event per line as messages arrive. Stop with Ctrl-C;
# re-running resumes where it stopped (cursor file).
# Usage: bash watch.sh [CHAT_ID]   (no argument = all chats)
set -u
CURSOR_FILE="${WX_CURSOR_FILE:-$HOME/.cache/wx-events.cursor}"
mkdir -p "$(dirname "$CURSOR_FILE")"
if [ $# -ge 1 ]; then
  echo "watching events (all chats; filter for chat $1 in the output) ..."
fi
exec wx events watch --json --cursor-file "$CURSOR_FILE"
