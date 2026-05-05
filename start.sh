#!/usr/bin/env bash
# start.sh — convenience launcher for the MCP-to-HTTP bridge
# Usage: ./start.sh [--config path/to/mcp-config.json] [--port 3100]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
  echo "[start.sh] node_modules not found — running npm install..."
  npm install
fi

# Brave Search API key for built-in web_search tool
# Get a free key at https://brave.com/search/api/
# Set it in your environment before running: export BRAVE_SEARCH_API_KEY=your_key_here
export BRAVE_SEARCH_API_KEY="${BRAVE_SEARCH_API_KEY:-}"

echo "[start.sh] Starting MCP-to-HTTP bridge..."
exec node server.js "$@"
