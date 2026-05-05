#!/bin/bash
# Start Ollama + MCP bridge together

echo "Starting Ollama..."
OLLAMA_HOST=0.0.0.0 ollama serve &
OLLAMA_PID=$!

echo "Ollama PID: $OLLAMA_PID"

echo "Starting MCP bridge..."
cd "$(dirname "$0")"
./start.sh &
BRIDGE_PID=$!

echo "Bridge PID: $BRIDGE_PID"
echo "Both running. Kill with: kill $OLLAMA_PID $BRIDGE_PID"

wait
