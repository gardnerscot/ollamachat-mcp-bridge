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
  app.get('/tools', (_req, res) => {
    try {
      const tools = manager.getTools();
      res.json({ tools });
    } catch (err) {
      logError('GET /tools failed', err);
      res.status(500).json({ error: 'Failed to retrieve tools', detail: err.message });
    }
  });

  // ── GET /tools/openai ──────────────────────────────────────────────────────
  app.get('/tools/openai', (_req, res) => {
    try {
      const tools = manager.getToolsOpenAI();
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

  // ── GET/POST /config ───────────────────────────────────────────────────────
  app.get('/config', (_req, res) => {
    res.json({ braveSearchApiKey: getBraveKey() });
  });

  app.post('/config', (req, res) => {
    const { braveSearchApiKey } = req.body || {};
    if (typeof braveSearchApiKey === 'string') {
      setBraveKey(braveSearchApiKey);
      log(`Brave API key updated`);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Bad request', detail: 'Body must include "braveSearchApiKey" (string)' });
    }
  });

  // ── 404 fallback ───────────────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not found',
      availableEndpoints: ['GET /health', 'GET /tools', 'GET /tools/openai', 'POST /call', 'GET /config', 'POST /config'],
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
