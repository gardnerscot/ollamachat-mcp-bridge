'use strict';

/**
 * streamable-handler.js
 * MCP Streamable HTTP transport for the bridge server.
 *
 * Implements the newer MCP transport (spec 2025-03-26 / 2025-06-18):
 *   POST   /mcp — all JSON-RPC traffic; responses are plain application/json
 *   GET    /mcp — 405 (server does not offer a server→client SSE stream)
 *   DELETE /mcp — 405 (server is stateless; no sessions to terminate)
 *
 * Statelessness: no Mcp-Session-Id is issued. This is spec-legal and keeps
 * restarts cheap. For clients that insist on Origin validation we mirror the
 * 2025-06-18 DNS-rebinding rule: reject cross-origin requests, allow
 * same-origin / null / non-browser origins through.
 *
 * JSON-RPC methods supported:
 *   initialize                  — handshake, echoes a supported protocol version
 *   notifications/*             — 202 Accepted, no body
 *   ping                        — {}
 *   tools/list                  — aggregated tool list in MCP format
 *   tools/call                  — executes a tool; failures returned as isError content
 */

const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

function toolToMCPFormat(tool) {
  return {
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  };
}

function toolResultToMCPFormat(result) {
  if (result && result.isError) {
    return {
      content: (result.content && result.content.length ? result.content : [{ type: 'text', text: 'Tool call failed' }]),
      isError: true,
    };
  }
  if (result && Array.isArray(result.content)) {
    return { content: result.content };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
}

function rpcResult(res, id, result) {
  res.status(200).json({ jsonrpc: '2.0', id, result });
}

function rpcError(res, id, code, message) {
  res.status(200).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/**
 * Origin guard per 2025-06-18 §2.9: if Origin is present and its host:port
 * differs from the Host header, reject. Allow 'null' (extensions) and
 * non-http origins (native clients).
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return true;
  try {
    const o = new URL(origin);
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return true;
    return o.host === req.headers.host;
  } catch (_) {
    return true;
  }
}

async function handleSingle(req, res, manager, msg) {
  const { method, params, id } = msg || {};

  if (!method || typeof method !== 'string') {
    return rpcError(res, id ?? null, -32600, 'Invalid Request');
  }

  // Notifications: no response per JSON-RPC, acknowledged with 202.
  if (method.startsWith('notifications/')) {
    return res.status(202).end();
  }

  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      const protocolVersion =
        requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      return rpcResult(res, id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'sg1-mcp-bridge',
          version: '1.1.0',
        },
      });
    }

    if (method === 'ping') {
      return rpcResult(res, id, {});
    }

    if (method === 'tools/list') {
      const tools = await manager.getTools();
      return rpcResult(res, id, { tools: tools.map(toolToMCPFormat) });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      if (!toolName) return rpcError(res, id, -32602, 'Missing tool name');
      const toolArgs = params?.arguments || {};
      try {
        const result = await manager.callTool(toolName, toolArgs);
        return rpcResult(res, id, toolResultToMCPFormat(result));
      } catch (err) {
        // Tool execution errors travel inside a successful JSON-RPC result (MCP spec).
        return rpcResult(res, id, {
          content: [{ type: 'text', text: `Tool error: ${err.message}` }],
          isError: true,
        });
      }
    }

    return rpcError(res, id, -32601, `Method not found: ${method}`);
  } catch (err) {
    return rpcError(res, id ?? null, -32603, err.message);
  }
}

function createStreamableHandler(manager) {
  async function handlePost(req, res) {
    if (!originAllowed(req)) {
      return res.status(403).json({ error: 'Forbidden', detail: 'Cross-origin request rejected' });
    }

    const body = req.body;
    if (body === undefined || body === null) {
      return rpcError(res, null, -32700, 'Parse error');
    }

    if (Array.isArray(body)) {
      // Batch requests (2025-03-26). Responses array in order.
      const replies = [];
      for (const msg of body) {
        if (msg && typeof msg.method === 'string' && msg.method.startsWith('notifications/')) continue;
        // capture into replies by monkey-patching res — simpler: replicate logic inline
        replies.push(await handleSingleCapture(manager, msg));
      }
      if (replies.length === 0) return res.status(202).end();
      return res.status(200).json(replies);
    }

    return handleSingle(req, res, manager, body);
  }

  // Minimal capture path for batch entries (no res involved).
  async function handleSingleCapture(manager, msg) {
    const { method, params, id } = msg || {};
    if (!method || typeof method !== 'string') return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    try {
      if (method === 'initialize') {
        const requested = params?.protocolVersion;
        const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
        return { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sg1-mcp-bridge', version: '1.1.0' } } };
      }
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (method === 'tools/list') {
        const tools = await manager.getTools();
        return { jsonrpc: '2.0', id, result: { tools: tools.map(toolToMCPFormat) } };
      }
      if (method === 'tools/call') {
        const result = await manager.callTool(params?.name, params?.arguments || {});
        return { jsonrpc: '2.0', id, result: toolResultToMCPFormat(result) };
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: err.message } };
    }
  }

  function handleGet(_req, res) {
    res.setHeader('Allow', 'POST, DELETE');
    // 405 = "no server→client stream here", which spec-compliant clients treat as fine.
    res.status(405).json({ error: 'Method not allowed', detail: 'This server does not provide a GET SSE stream. Use POST /mcp.' });
  }

  function handleDelete(_req, res) {
    res.status(405).json({ error: 'Method not allowed', detail: 'Server is stateless; no session to terminate.' });
  }

  return { handlePost, handleGet, handleDelete };
}

module.exports = { createStreamableHandler };
