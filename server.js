'use strict';

/**
 * server.js
 * MCP-to-HTTP Bridge Server
 *
 * Spawns stdio-based MCP servers as child processes and exposes
 * their tools over HTTP so an Android app (or any HTTP client) can call them.
 *
 * Usage:
 *   node server.js [--config <path>] [--port <number>]
 *
 * Environment variables:
 *   PORT        — HTTP port (default: 3100)
 *   CONFIG      — path to mcp-config.json
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { McpManager, getBraveKey, setBraveKey } = require('./mcp-manager');
const { createSSEHandler } = require('./sse-handler');

// ─── CLI / env args ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) result.config = args[++i];
    if (args[i] === '--port' && args[i + 1]) result.port = parseInt(args[++i], 10);
  }
  return result;
}

const cliArgs = parseArgs();
const PORT = cliArgs.port || parseInt(process.env.PORT || '3100', 10);
const CONFIG_PATH = cliArgs.config || process.env.CONFIG || path.join(__dirname, 'mcp-config.json');

// ─── Logging ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${ts()}] [server] ${msg}`);
}

function logError(msg, err) {
  console.error(`[${ts()}] [server] ERROR: ${msg}`, err ? err.stack || err.message || err : '');
}

// ─── Load config ──────────────────────────────────────────────────────────────

function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    logError(`Config file not found: ${resolved}`);
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const cfg = JSON.parse(raw);
    log(`Loaded config from ${resolved} — ${Object.keys(cfg).length} server(s) defined`);
    return cfg;
  } catch (err) {
    logError(`Failed to parse config file: ${resolved}`, err);
    process.exit(1);
  }
}

// ─── Express app ──────────────────────────────────────────────────────────────

function buildApp(manager) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // ── Request logging middleware ─────────────────────────────────────────────
  app.use((req, _res, next) => {
    log(`${req.method} ${req.path}`);
    next();
  });

  // ── GET /health ────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    const servers = manager.getStatus();
    const allOk = Object.values(servers).every((s) => s === 'connected');
    res.status(allOk ? 200 : 207).json({
      status: allOk ? 'ok' : 'degraded',
      servers,
    });
  });

  // ── GET /tools ─────────────────────────────────────────────────────────────
  app.get('/tools', async (_req, res) => {
    try {
      const tools = await manager.getTools();
      res.json({ tools });
    } catch (err) {
      logError('GET /tools failed', err);
      res.status(500).json({ error: 'Failed to retrieve tools', detail: err.message });
    }
  });

  // ── GET /tools/openai ──────────────────────────────────────────────────────
  app.get('/tools/openai', async (_req, res) => {
    try {
      const tools = await manager.getToolsOpenAI();
      res.json(tools);
    } catch (err) {
      logError('GET /tools/openai failed', err);
      res.status(500).json({ error: 'Failed to retrieve OpenAI tools', detail: err.message });
    }
  });

  // ── POST /call ─────────────────────────────────────────────────────────────
  app.post('/call', async (req, res) => {
    const { name, arguments: args } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: 'Bad request',
        detail: 'Body must include "name" (string) field',
      });
    }

    try {
      const result = await manager.callTool(name, args || {});
      res.json(result);
    } catch (err) {
      const statusCode = err.statusCode || 500;
      logError(`POST /call "${name}" failed`, err);
      res.status(statusCode).json({
        error: err.message,
        isError: true,
      });
    }
  });

  // ── Custom tools CRUD ─────────────────────────────────────────────────────
  const CUSTOM_TOOLS_PATH = path.join(__dirname, 'custom-tools.json');

  function loadCustomTools() {
    try {
      if (fs.existsSync(CUSTOM_TOOLS_PATH)) {
        return JSON.parse(fs.readFileSync(CUSTOM_TOOLS_PATH, 'utf8'));
      }
    } catch (e) {
      logError('Failed to load custom tools', e);
    }
    return [];
  }

  function saveCustomTools(tools) {
    fs.writeFileSync(CUSTOM_TOOLS_PATH, JSON.stringify(tools, null, 2), 'utf8');
  }

  app.get('/custom-tools', (_req, res) => {
    res.json({ tools: loadCustomTools() });
  });

  app.post('/custom-tools', (req, res) => {
    const { name, description, inputSchema, command } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Bad request', detail: '"name" (string) is required' });
    }
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'Bad request', detail: '"command" (string) is required' });
    }
    const tools = loadCustomTools();
    const existing = tools.findIndex(t => t.name === name);
    const tool = {
      name,
      description: description || '',
      inputSchema: inputSchema || { type: 'object', properties: {} },
      command,
      server: 'custom',
    };
    if (existing >= 0) {
      tools[existing] = tool;
    } else {
      tools.push(tool);
    }
    saveCustomTools(tools);
    log(`Custom tool ${existing >= 0 ? 'updated' : 'added'}: ${name}`);
    res.json({ ok: true, tool });
  });

  app.delete('/custom-tools/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const tools = loadCustomTools();
    const filtered = tools.filter(t => t.name !== name);
    if (filtered.length === tools.length) {
      return res.status(404).json({ error: 'Not found', detail: `No custom tool named "${name}"` });
    }
    saveCustomTools(filtered);
    log(`Custom tool deleted: ${name}`);
    res.json({ ok: true });
  });

  // ── GET/POST /config ───────────────────────────────────────────────────────
  app.get('/config', (_req, res) => {
    res.json({
      braveSearchApiKey: getBraveKey(),
    });
  });

  app.post('/config', (req, res) => {
    const { braveSearchApiKey } = req.body || {};
    let updated = [];
    if (typeof braveSearchApiKey === 'string' && braveSearchApiKey) {
      setBraveKey(braveSearchApiKey);
      updated.push('braveSearchApiKey');
    }
    if (updated.length > 0) {
      log(`Config updated: ${updated.join(', ')}`);
      res.json({ success: true, updated });
    } else {
      res.status(400).json({ error: 'Bad request', detail: 'Body must include "braveSearchApiKey" (string)' });
    }
  });

  // ── GET /sse ──────────────────────────────────────────────────────────────
  // ── POST /messages ────────────────────────────────────────────────────────
  const sse = createSSEHandler(manager);
  app.get('/sse', sse.handleSSE);
  app.post('/messages', sse.handleMessages);

  // ── 404 fallback ───────────────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not found',
      availableEndpoints: ['GET /health', 'GET /sse', 'POST /messages', 'GET /tools', 'GET /tools/openai', 'POST /call', 'GET /config', 'POST /config'],
    });
  });

  // ── Global error handler ───────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logError('Unhandled express error', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  });

  return app;
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function setupShutdown(manager, server) {
  const shutdown = (signal) => {
    log(`${signal} received — shutting down gracefully`);
    manager.stopAll();
    server.close(() => {
      log('HTTP server closed');
      process.exit(0);
    });
    // Force exit after 5s if something hangs
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('MCP-to-HTTP Bridge starting up');
  log(`Config: ${CONFIG_PATH}`);
  log(`Port:   ${PORT}`);

  const config = loadConfig(CONFIG_PATH);
  const manager = new McpManager(config);

  log('Starting MCP servers...');
  await manager.startAll();

  const status = manager.getStatus();
  for (const [name, s] of Object.entries(status)) {
    log(`  ${name}: ${s}`);
  }

  const app = buildApp(manager);

  const server = app.listen(PORT, '0.0.0.0', () => {
    log(`HTTP server listening on 0.0.0.0:${PORT}`);
    log('Endpoints:');
    log('  GET  /health       — server health');
    log('  GET  /tools        — aggregated MCP tool list');
    log('  GET  /tools/openai — OpenAI function-calling format');
    log('  POST /call         — execute a tool call');
  });

  setupShutdown(manager, server);
}

main().catch((err) => {
  logError('Fatal startup error', err);
  process.exit(1);
});
