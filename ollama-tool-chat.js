#!/usr/bin/env node
'use strict';

/**
 * ollama-tool-chat.js
 * Terminal wrapper for Ollama + MCP bridge tool calling.
 *
 * Usage: node ollama-tool-chat.js "What's the weather in Waynesboro, PA?"
 *   or:  ./ollama-tool-chat.js "Current BTC price?"
 *
 * Requires: MCP bridge running on localhost:3100 (./start.sh)
 */

const http = require('http');
const https = require('https');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:3100';
const MODEL = process.env.OLLAMA_MODEL || 'qwen3.6:latest';
const MAX_TOOL_ROUNDS = 5;

// ─── Helpers ────────────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${e.message} — ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const payload = JSON.stringify(body);
    const opts = new URL(url);
    const req = lib.request({
      hostname: opts.hostname,
      port: opts.port,
      path: opts.pathname + opts.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${e.message} — ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function fetchTools() {
  try {
    const tools = await httpGet(`${BRIDGE_URL}/tools/openai`);
    return tools;
  } catch (err) {
    console.error(`⚠️  Could not fetch tools from bridge (${err.message}) — running without tools`);
    return [];
  }
}

async function executeToolCall(toolName, args) {
  try {
    const result = await httpPost(`${BRIDGE_URL}/call`, { name: toolName, arguments: args });
    return result;
  } catch (err) {
    return { content: [{ type: 'text', text: `Tool call failed: ${err.message}` }], isError: true };
  }
}

// ─── Streaming chat ─────────────────────────────────────────────────────────

function chatStream(body, tools) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ ...body, tools, stream: true });
    const opts = new URL(`${OLLAMA_URL}/api/chat`);
    const req = http.request({
      hostname: opts.hostname,
      port: opts.port,
      path: opts.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let buffer = '';
      let fullContent = '';
      const toolCalls = new Map(); // index -> { name, args }

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.message?.content) {
              fullContent += msg.message.content;
              process.stdout.write(msg.message.content);
            }
            if (msg.message?.tool_calls) {
              for (const tc of msg.message.tool_calls) {
                const idx = tc.index ?? toolCalls.size;
                const existing = toolCalls.get(idx) || { name: '', args: '' };
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
                toolCalls.set(idx, existing);
              }
            }
          } catch (e) { /* skip partial JSON */ }
        }
      });

      res.on('end', () => {
        // Flush final buffer line
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer);
            if (msg.message?.content) {
              fullContent += msg.message.content;
              process.stdout.write(msg.message.content);
            }
            if (msg.message?.tool_calls) {
              for (const tc of msg.message.tool_calls) {
                const idx = tc.index ?? toolCalls.size;
                const existing = toolCalls.get(idx) || { name: '', args: '' };
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
                toolCalls.set(idx, existing);
              }
            }
          } catch (e) { /* ignore */ }
        }
        resolve({ content: fullContent, toolCalls: [...toolCalls.values()] });
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const prompt = process.argv.slice(2).join(' ');

  if (!prompt) {
    console.log('Usage: node ollama-tool-chat.js "Your question here"');
    console.log('');
    console.log('  OLLAMA_URL  Ollama API URL (default: http://localhost:11434)');
    console.log('  BRIDGE_URL  MCP bridge URL (default: http://localhost:3100)');
    console.log('  OLLAMA_MODEL Model to use (default: deepseek-r1:32b)');
    process.exit(1);
  }

  console.log(`🤖 ${MODEL} — fetching tools from bridge...`);

  const tools = await fetchTools();
  if (tools.length > 0) {
    console.log(`🔧 ${tools.length} tools loaded\n`);
  } else {
    console.log('(no tools available)\n');
  }

  const messages = [{ role: 'user', content: prompt }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    process.stdout.write('💬 ');
    const result = await chatStream({ model: MODEL, messages }, tools);
    process.stdout.write('\n');

    if (result.toolCalls.length === 0) {
      // No tool calls — final answer delivered
      break;
    }

    // Execute tool calls
    console.log('');
    for (const tc of result.toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.args); } catch (e) { /* raw string */ }

      // Inject query from user prompt if model left it empty
      if ((tc.name === 'weather_search' || tc.name === 'builtin__weather_search') && !args.query) {
        args.query = prompt;
        console.log(`🔧 Calling ${tc.name}(${JSON.stringify(args)})... [query injected from prompt]`);
      } else {
        console.log(`🔧 Calling ${tc.name}(${JSON.stringify(args)})...`);
      }
      const toolResult = await executeToolCall(tc.name, args);

      const resultText = toolResult.content?.map((c) => c.text).join('\n') || JSON.stringify(toolResult);
      console.log(`   → ${resultText}`);

      messages.push({
        role: 'assistant',
        content: result.content || '',
        tool_calls: [{ function: { name: tc.name, arguments: tc.args } }],
      });
      messages.push({ role: 'tool', content: resultText });
    }
    console.log('');
  }

  console.log('\n✨ Done.');
}

main().catch((err) => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
