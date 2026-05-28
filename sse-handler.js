'use strict';

/**
 * sse-handler.js
 * MCP-over-SSE transport for the bridge server.
 *
 * Implements the standard MCP SSE protocol:
 *   GET  /sse        — opens SSE stream, returns endpoint event
 *   POST /messages   — JSON-RPC 2.0 requests, responses streamed via SSE
 *
 * JSON-RPC methods supported:
 *   initialize     — handshake
 *   tools/list     — returns all tools (MCP + Osaurus + builtin)
 *   tools/call     — executes a tool by name
 */

const crypto = require('crypto');

// In-memory session store: sessionId → { res, createdAt }
const sessions = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      try { session.res.end(); } catch (_) { /* ignore */ }
      sessions.delete(id);
    }
  }
}, 60_000);

function createSessionId() {
  return crypto.randomUUID();
}

function sendSSE(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendJSONRPCResponse(res, id, result) {
  sendSSE(res, 'message', { jsonrpc: '2.0', id, result });
}

function sendJSONRPCError(res, id, code, message) {
  sendSSE(res, 'message', { jsonrpc: '2.0', id, error: { code, message } });
}

function toolToMCPFormat(tool) {
  return {
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  };
}

function toolResultToMCPFormat(result) {
  // result from callTool is { content: [{ type: 'text', text: '...' }], isError }
  if (result.isError) {
    return {
      content: result.content || [{ type: 'text', text: 'Tool call failed' }],
      isError: true,
    };
  }
  return {
    content: result.content || [{ type: 'text', text: JSON.stringify(result) }],
  };
}

/**
 * Create the SSE + messages route handlers.
 * @param {object} manager — McpManager instance (has getTools() and callTool())
 */
function createSSEHandler(manager) {
  /**
   * GET /sse — opens SSE connection, sends endpoint event with session-scoped messages URL.
   */
  function handleSSE(req, res) {
    const sessionId = createSessionId();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send endpoint event with absolute URL (MCP SDK resolves relative paths against SSE URL)
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3100';
    const baseUrl = `${protocol}://${host}`;
    res.write(`event: endpoint\ndata: ${baseUrl}/messages?sessionId=${sessionId}\n\n`);

    sessions.set(sessionId, { res, createdAt: Date.now() });

    // Keep-alive ping every 30s
    const pingInterval = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        clearInterval(pingInterval);
      }
    }, 30_000);

    req.on('close', () => {
      clearInterval(pingInterval);
      sessions.delete(sessionId);
    });
  }

  /**
   * POST /messages — handles JSON-RPC requests.
   * Expects query param ?sessionId=... matching an active SSE session.
   */
  async function handleMessages(req, res) {
    const sessionId = req.query?.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId query parameter' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object') {
      return sendJSONRPCError(session.res, null, -32600, 'Invalid Request');
    }

    const { method, params, id } = body;

    try {
      if (method === 'initialize') {
        sendJSONRPCResponse(session.res, id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'olla-mcp-bridge',
            version: '1.0.0',
          },
        });
      } else if (method === 'tools/list') {
        const tools = await manager.getTools();
        sendJSONRPCResponse(session.res, id, {
          tools: tools.map(toolToMCPFormat),
        });
      } else if (method === 'tools/call') {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        if (!toolName) {
          return sendJSONRPCError(session.res, id, -32602, 'Missing tool name');
        }

        const result = await manager.callTool(toolName, toolArgs);
        sendJSONRPCResponse(session.res, id, toolResultToMCPFormat(result));
      } else if (method === 'notifications/initialized') {
        // Client confirms initialization — no response needed per spec
        // Just acknowledge with HTTP 202
        res.status(202).json({});
      } else {
        sendJSONRPCError(session.res, id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      sendJSONRPCError(session.res, id, -32603, err.message);
    }

    // Always close the HTTP response for /messages — responses go via SSE
    if (!res.headersSent) {
      res.status(202).json({});
    }
  }

  return { handleSSE, handleMessages };
}

module.exports = { createSSEHandler };
