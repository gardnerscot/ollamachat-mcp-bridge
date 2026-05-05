# MCP-to-HTTP Bridge Server

Spawns stdio-based MCP servers as child processes and exposes their tools over HTTP — so an Android app (or any HTTP client) can use them without needing direct process access.

## Quick Start

```bash
cd /Users/scotgardner/.cola/outputs/MCP-to-HTTP-bridge-server
npm install
./start.sh
```

Or manually:

```bash
node server.js
node server.js --config /path/to/mcp-config.json --port 3100
```

Environment variables also work:

```bash
PORT=3100 CONFIG=./mcp-config.json node server.js
```

## Default Config

The included `mcp-config.json` starts three servers:

| Key | Tool | Launch |
|---|---|---|
| `reminders` | Apple Reminders | `npx reminders-mcp` |
| `notes` | Apple Notes | `npx apple-notes-mcp` |
| `mail` | Spark Mail | `uv run spark-mail-mcp` |

To disable a server temporarily, set `"disabled": true` in the config.

## HTTP Endpoints

All endpoints are served on `0.0.0.0:3100` (CORS enabled).

---

### `GET /health`

Returns status of every MCP server.

```json
{
  "status": "ok",
  "servers": {
    "reminders": "connected",
    "notes": "connected",
    "mail": "connected"
  }
}
```

Possible `status` values for each server: `connecting`, `connected`, `disconnected`, `error`.

HTTP 200 when all connected, HTTP 207 when degraded.

---

### `GET /tools`

Returns all tools from all connected servers, namespaced with `servername__`.

```json
{
  "tools": [
    {
      "name": "reminders__list_reminders",
      "description": "List all reminders",
      "inputSchema": { "type": "object", "properties": { "list": { "type": "string" } } },
      "server": "reminders"
    },
    {
      "name": "mail__list_emails",
      "description": "List recent emails",
      "inputSchema": { ... },
      "server": "mail"
    }
  ]
}
```

---

### `GET /tools/openai`

Same tools in OpenAI function-calling format (directly usable as the `tools` parameter in Ollama requests).

```json
[
  {
    "type": "function",
    "function": {
      "name": "reminders__list_reminders",
      "description": "List all reminders",
      "parameters": { "type": "object", "properties": { ... } }
    }
  }
]
```

---

### `POST /call`

Execute a tool call.

**Request:**
```json
{
  "name": "reminders__list_reminders",
  "arguments": {
    "list": "Shopping"
  }
}
```

**Success response** (MCP format):
```json
{
  "content": [
    { "type": "text", "text": "Buy milk\nBuy eggs" }
  ],
  "isError": false
}
```

**Error responses:**
- `400` — bad request (missing `name`, unknown server, malformed prefix)
- `503` — server not connected
- `500` — tool execution error

---

## File Structure

```
MCP-to-HTTP-bridge-server/
  package.json       — npm metadata + dependencies (express, cors)
  server.js          — Express app, CLI arg parsing, startup/shutdown
  mcp-process.js     — Manages one MCP child process (JSON-RPC, restart)
  mcp-manager.js     — Manages all processes, aggregates + routes calls
  mcp-config.json    — Default config (reminders, notes, mail)
  start.sh           — Convenience launcher (auto npm install)
  README.md          — This file
```

## Adding a New MCP Server

Add an entry to `mcp-config.json`:

```json
{
  "myserver": {
    "command": "node",
    "args": ["/path/to/my-mcp-server/index.js"],
    "env": {
      "MY_API_KEY": "secret"
    },
    "disabled": false
  }
}
```

Restart the bridge. Tools will be exposed as `myserver__<toolname>`.

## Connecting from Android

The bridge binds to `0.0.0.0` so it's reachable from your phone on the local network.

1. Find your Mac's local IP: `ipconfig getifaddr en0`
2. From Android, use `http://<mac-ip>:3100`

Typical call from the Android app:

```kotlin
val body = """{"name":"reminders__list_reminders","arguments":{}}"""
val response = httpClient.post("http://192.168.1.x:3100/call") {
    contentType(ContentType.Application.Json)
    setBody(body)
}
```

## Error Handling

- If a child process dies, it is automatically restarted after 5 seconds.
- Tool calls timeout after 30 seconds.
- Pending RPC calls are rejected immediately when a process exits.
- Each server's failure is isolated — other servers continue working.
