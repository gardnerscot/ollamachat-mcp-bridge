'use strict';

/**
 * mcp-process.js
 * Manages a single stdio-based MCP child process:
 *   - spawn / restart
 *   - JSON-RPC framing over stdin/stdout
 *   - initialize handshake
 *   - tools/list caching
 *   - tools/call with timeout
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');

const TOOL_CALL_TIMEOUT_MS = 30_000;
const RESTART_DELAY_MS = 5_000;

function ts() {
  return new Date().toISOString();
}

class McpProcess extends EventEmitter {
  /**
   * @param {string} name       - logical server name (e.g. "reminders")
   * @param {object} config     - { command, args, env }
   */
  constructor(name, config) {
    super();
    this.name = name;
    this.config = config;

    this.proc = null;
    this.status = 'disconnected'; // 'connecting' | 'connected' | 'disconnected' | 'error'
    this.tools = [];              // cached tool list (MCP format)

    this._buf = '';               // stdout line buffer
    this._nextId = 1;
    this._pending = new Map();    // id -> { resolve, reject, timer }
    this._restarting = false;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async start() {
    this._restarting = false;
    await this._spawn();
  }

  async callTool(toolName, args) {
    if (this.status !== 'connected') {
      const err = new Error(`MCP server "${this.name}" is not connected (status: ${this.status})`);
      err.statusCode = 503;
      throw err;
    }
    const result = await this._rpc('tools/call', { name: toolName, arguments: args || {} });
    return result;
  }

  stop() {
    this._restarting = false; // prevent auto-restart
    this._kill();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  async _spawn() {
    this.status = 'connecting';
    this._buf = '';

    const { command, args = [], env = {} } = this.config;
    const childEnv = { ...process.env, ...env };

    this._log(`Spawning: ${command} ${args.join(' ')}`);

    try {
      this.proc = spawn(command, args, {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._error(`Failed to spawn: ${err.message}`);
      this.status = 'error';
      this._scheduleRestart();
      return;
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (line) => {
      // Suppress empty lines; log the rest at debug level
      const trimmed = line.trim();
      if (trimmed) this._log(`[stderr] ${trimmed}`);
    });

    this.proc.on('error', (err) => {
      this._error(`Process error: ${err.message}`);
      this.status = 'error';
      this._rejectAllPending(err);
      this._scheduleRestart();
    });

    this.proc.on('exit', (code, signal) => {
      this._log(`Process exited (code=${code}, signal=${signal})`);
      if (this.status !== 'disconnected') {
        this.status = 'error';
        const err = new Error(`MCP server "${this.name}" exited unexpectedly`);
        this._rejectAllPending(err);
        this._scheduleRestart();
      }
    });

    try {
      await this._initialize();
      await this._loadTools();
      this.status = 'connected';
      this._log(`Ready — ${this.tools.length} tool(s) loaded`);
      this.emit('ready');
    } catch (err) {
      this._error(`Initialization failed: ${err.message}`);
      this.status = 'error';
      this._scheduleRestart();
    }
  }

  async _initialize() {
    // Send initialize request
    const initResult = await this._rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'mcp-http-bridge', version: '1.0.0' },
    });

    this._log(`Server info: ${JSON.stringify(initResult.serverInfo || {})}`);

    // Send initialized notification (no response expected)
    this._notify('notifications/initialized', {});
  }

  async _loadTools() {
    const result = await this._rpc('tools/list', {});
    this.tools = result.tools || [];
  }

  // ─── JSON-RPC ─────────────────────────────────────────────────────────────

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const message = { jsonrpc: '2.0', id, method, params };

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (id=${id}) on server "${this.name}"`));
      }, TOOL_CALL_TIMEOUT_MS);

      this._pending.set(id, { resolve, reject, timer });
      this._send(message);
    });
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  _send(obj) {
    if (!this.proc || !this.proc.stdin.writable) {
      this._error('Tried to send but stdin is not writable');
      return;
    }
    const line = JSON.stringify(obj) + '\n';
    this.proc.stdin.write(line);
  }

  _onData(chunk) {
    this._buf += chunk;
    const lines = this._buf.split('\n');
    // Keep the last (potentially incomplete) fragment
    this._buf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch (err) {
        this._error(`Failed to parse message: ${trimmed.slice(0, 200)}`);
      }
    }
  }

  _handleMessage(msg) {
    // Notifications from the server (no id) — ignore for now
    if (msg.id === undefined || msg.id === null) return;

    const pending = this._pending.get(msg.id);
    if (!pending) {
      this._error(`No pending RPC for id=${msg.id}`);
      return;
    }

    clearTimeout(pending.timer);
    this._pending.delete(msg.id);

    if (msg.error) {
      const err = new Error(msg.error.message || 'RPC error');
      err.code = msg.error.code;
      err.data = msg.error.data;
      pending.reject(err);
    } else {
      pending.resolve(msg.result);
    }
  }

  _rejectAllPending(err) {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this._pending.delete(id);
    }
  }

  // ─── Restart ──────────────────────────────────────────────────────────────

  _scheduleRestart() {
    if (this._restarting) return;
    this._restarting = true;
    this._log(`Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(() => {
      if (!this._restarting) return; // stop() was called
      this._kill();
      this._spawn();
    }, RESTART_DELAY_MS);
  }

  _kill() {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch (_) { /* already dead */ }
      this.proc = null;
    }
    this.status = 'disconnected';
  }

  // ─── Logging ──────────────────────────────────────────────────────────────

  _log(msg) {
    console.log(`[${ts()}] [${this.name}] ${msg}`);
  }

  _error(msg) {
    console.error(`[${ts()}] [${this.name}] ERROR: ${msg}`);
  }
}

module.exports = McpProcess;
