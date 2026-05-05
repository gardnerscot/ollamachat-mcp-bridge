'use strict';

/**
 * mcp-manager.js
 * Manages all MCP child processes defined in the config.
 * Aggregates tool lists (with server-prefix namespacing) and
 * routes tool calls to the correct process.
 * Includes built-in tools (Brave Search) that don't need an MCP server.
 */

const McpProcess = require('./mcp-process');
const https = require('https');

const SERVER_PREFIX_SEP = '__';

// ─── Built-in tools (no MCP server needed) ────────────────────────────────────

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY || '';
let braveKey = BRAVE_API_KEY; // mutable runtime override

const BUILTIN_TOOLS = [
  {
    name: 'builtin__web_search',
    description: 'Search the web using Brave Search. Returns titles, URLs, and descriptions of top results. Use this for any question about current events, prices, news, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        count: {
          type: 'number',
          description: 'Number of results to return (default 5, max 20)',
        },
      },
      required: ['query'],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__weather_search',
    description: 'Get current weather conditions and forecast for a location. Use this for any question about current temperature, humidity, wind, or weather forecast.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Location to get weather for, e.g. "Waynesboro, PA" or "Gettysburg, Pennsylvania"',
        },
      },
      required: ['query'],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__crypto_price',
    description: 'Get current cryptocurrency prices in USD or other currencies. Use when asked about Bitcoin, Ethereum, Solana, or any crypto price.',
    inputSchema: {
      type: 'object',
      properties: {
        coins: {
          type: 'string',
          description: 'Comma-separated coin IDs, e.g. "bitcoin,ethereum,solana". Common IDs: bitcoin, ethereum, solana, cardano, dogecoin, xrp, polkadot, avalanche, chainlink, litecoin',
        },
        currency: {
          type: 'string',
          description: 'Currency code (default: usd). Supports usd, eur, gbp, jpy, cny, etc.',
        },
      },
      required: ['coins'],
    },
    server: 'builtin',
  },
];

async function executeBuiltinTool(toolName, args) {
  if (toolName === 'web_search') {
    return await braveSearch(args.query, args.count || 5);
  }
  if (toolName === 'weather_search') {
    return await weatherSearch(args.query);
  }
  if (toolName === 'crypto_price') {
    return await cryptoPrice(args.coins, args.currency);
  }
  throw Object.assign(new Error(`Unknown builtin tool: ${toolName}`), { statusCode: 400 });
}

function getBraveKey() { return braveKey; }
function setBraveKey(key) { braveKey = key; }

function braveSearch(query, count) {
  return new Promise((resolve, reject) => {
    if (!braveKey) {
      return resolve({
        content: [{ type: 'text', text: 'Brave Search API key not configured. Set BRAVE_SEARCH_API_KEY environment variable.' }],
        isError: true,
      });
    }

    const params = new URLSearchParams({ q: query, count: String(Math.min(count, 20)) });
    const url = `https://api.search.brave.com/res/v1/web/search?${params}`;

    const req = https.get(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': braveKey,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            return resolve({
              content: [{ type: 'text', text: `Brave Search error: HTTP ${res.statusCode} — ${data}` }],
              isError: true,
            });
          }
          const json = JSON.parse(data);
          const results = (json.web?.results || []).slice(0, count).map((r, i) => (
            `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description || ''}`
          ));
          const text = results.length > 0
            ? `Search results for "${query}":\n\n${results.join('\n\n')}`
            : `No results found for "${query}"`;
          resolve({
            content: [{ type: 'text', text }],
            isError: false,
          });
        } catch (err) {
          resolve({
            content: [{ type: 'text', text: `Failed to parse Brave Search response: ${err.message}` }],
            isError: true,
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({
        content: [{ type: 'text', text: `Brave Search request failed: ${err.message}` }],
        isError: true,
      });
    });

    req.setTimeout(15000, () => {
      req.destroy();
      resolve({
        content: [{ type: 'text', text: 'Brave Search request timed out' }],
        isError: true,
      });
    });
  });
}

function weatherSearch(location) {
  return new Promise((resolve) => {
    // Extract location from natural language queries like "weather in Waynesboro, PA"
    let query = location;
    const patterns = [
      /weather (?:in|for|at|near) (.+)/i,
      /(.+?)\s+weather/i,
      /(?:current|today'?s?)\s+weather\s+(?:in|for|at|near)?\s*(.+)/i,
      /what(?:'?s| is) the weather (?:in|for|at|near) (.+)/i,
    ];
    for (const p of patterns) {
      const m = query.match(p);
      if (m && m[1] && m[1].length > 3) {
        query = m[1].replace(/[?!.]+$/, '').trim();
        break;
      }
    }

    // Step 1: Geocode the location (Nominatim — better US coverage than Open-Meteo)
    const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&accept-language=en`;

    const geoOpts = {
      headers: {
        'User-Agent': 'OllamaChat-MCP-Bridge/1.0 (github.com/gardnerscot/ollamachat-mcp-bridge)',
        'Accept': 'application/json',
      },
    };
    const geoLib = https;

    geoLib.get(geoUrl, geoOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const geo = JSON.parse(data);
          if (!Array.isArray(geo) || geo.length === 0) {
            return resolve({
              content: [{ type: 'text', text: `Could not find location: "${query}". Try a more specific name like "Waynesboro, Pennsylvania".` }],
              isError: true,
            });
          }

          const place = geo[0];
          const latitude = parseFloat(place.lat);
          const longitude = parseFloat(place.lon);
          const displayName = place.display_name?.split(',').slice(0, 3).join(', ') || query;

          // Step 2: Fetch weather (imperial units for US)
          const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=3`;

          https.get(weatherUrl, (wres) => {
            let wdata = '';
            wres.on('data', (chunk) => { wdata += chunk; });
            wres.on('end', () => {
              try {
                const w = JSON.parse(wdata);
                const c = w.current;
                const d = w.daily;

                const weatherDesc = WMO_CODES[c.weather_code] || `Code ${c.weather_code}`;
                const dailyLines = d.time.map((day, i) => {
                  const code = WMO_CODES[d.weather_code[i]] || `Code ${d.weather_code[i]}`;
                  const precip = d.precipitation_probability_max[i] != null ? `, ${d.precipitation_probability_max[i]}% precip` : '';
                  return `  ${day}: ${code}, ${Math.round(d.temperature_2m_max[i])}°F / ${Math.round(d.temperature_2m_min[i])}°F${precip}`;
                }).join('\n');

                const text = [
                  `**Weather for ${displayName}**`,
                  '',
                  `🌡️ Currently **${Math.round(c.temperature_2m)}°F** (feels like ${Math.round(c.apparent_temperature)}°F)`,
                  `💧 Humidity: ${c.relative_humidity_2m}%`,
                  `💨 Wind: ${Math.round(c.wind_speed_10m)} mph (gusts up to ${Math.round(c.wind_gusts_10m)} mph)`,
                  `🌤️ Conditions: ${weatherDesc}`,
                  '',
                  '**3-Day Forecast:**',
                  dailyLines,
                ].join('\n');

                resolve({
                  content: [{ type: 'text', text }],
                  isError: false,
                });
              } catch (err) {
                resolve({
                  content: [{ type: 'text', text: `Failed to parse weather data: ${err.message}` }],
                  isError: true,
                });
              }
            });
          }).on('error', (err) => {
            resolve({
              content: [{ type: 'text', text: `Weather API request failed: ${err.message}` }],
              isError: true,
            });
          }).setTimeout(15000, function() { this.destroy(); resolve({ content: [{ type: 'text', text: 'Weather request timed out' }], isError: true }); });

        } catch (err) {
          resolve({
            content: [{ type: 'text', text: `Failed to geocode location: ${err.message}` }],
            isError: true,
          });
        }
      });
    }).on('error', (err) => {
      resolve({
        content: [{ type: 'text', text: `Geocoding request failed: ${err.message}` }],
        isError: true,
      });
    }).setTimeout(15000, function() { this.destroy(); resolve({ content: [{ type: 'text', text: 'Geocoding request timed out' }], isError: true }); });
  });
}

function cryptoPrice(coins, currency = 'usd') {
  return new Promise((resolve) => {
    const ids = coins.toLowerCase().replace(/\s+/g, '').split(',');
    const symbolMap = {
      bitcoin: 'BTC', btc: 'BTC',
      ethereum: 'ETH', eth: 'ETH',
      solana: 'SOL', sol: 'SOL',
      cardano: 'ADA', ada: 'ADA',
      dogecoin: 'DOGE', doge: 'DOGE',
      xrp: 'XRP', ripple: 'XRP',
      polkadot: 'DOT', dot: 'DOT',
      avalanche: 'AVAX', avax: 'AVAX',
      chainlink: 'LINK', link: 'LINK',
      litecoin: 'LTC', ltc: 'LTC',
    };

    const symbols = ids.map(id => symbolMap[id] || id.toUpperCase()).filter(Boolean);
    const vs = currency.toUpperCase();

    // Fetch prices in parallel (Coinbase only does one pair at a time)
    const promises = symbols.map(sym => {
      return new Promise((resolveOne) => {
        const url = `https://api.coinbase.com/v2/prices/${sym}-${vs}/spot`;
        https.get(url, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'OllamaChat/1.0' },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              if (res.statusCode !== 200) {
                return resolveOne({ error: `HTTP ${res.statusCode}` });
              }
              const j = JSON.parse(data);
              const amount = parseFloat(j.data?.amount || 0);
              resolveOne({ symbol: sym, price: amount, error: null });
            } catch {
              resolveOne({ error: 'parse error' });
            }
          });
        }).on('error', (err) => resolveOne({ error: err.message }))
          .setTimeout(10000, function() { this.destroy(); resolveOne({ error: 'timeout' }); });
      });
    });

    Promise.all(promises).then(results => {
      const lines = [];
      for (const r of results) {
        if (r.error) {
          lines.push(`**${r.symbol || '?'}**: Error — ${r.error}`);
        } else {
          const price = r.price;
          const formatted = price >= 1 ? `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${price.toFixed(price < 0.01 ? 6 : 4)}`;
          lines.push(`**${r.symbol}**: ${formatted} ${vs}`);
        }
      }
      if (lines.length === 0) {
        lines.push(`No prices found for "${coins}". Try: bitcoin, ethereum, solana.`);
      }
      resolve({
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
      });
    });
  });
}

// WMO Weather Codes → human-readable
const WMO_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

function ts() {
  return new Date().toISOString();
}

class McpManager {
  constructor(config) {
    /** @type {Map<string, McpProcess>} */
    this.servers = new Map();
    this._config = config;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async startAll() {
    const entries = Object.entries(this._config);
    if (entries.length === 0) {
      console.warn(`[${ts()}] [manager] Warning: no MCP servers in config`);
      return;
    }

    const startPromises = entries
      .filter(([, cfg]) => !cfg.disabled)
      .map(([name, cfg]) => this._startServer(name, cfg));

    // Start all in parallel; individual failures are handled inside McpProcess
    await Promise.allSettled(startPromises);
  }

  async _startServer(name, cfg) {
    const proc = new McpProcess(name, cfg);
    this.servers.set(name, proc);

    proc.on('ready', () => {
      console.log(`[${ts()}] [manager] Server "${name}" is ready`);
    });

    await proc.start();
  }

  stopAll() {
    for (const [, proc] of this.servers) {
      proc.stop();
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  getStatus() {
    const result = {};
    for (const [name, proc] of this.servers) {
      result[name] = proc.status;
    }
    return result;
  }

  // ─── Tools ────────────────────────────────────────────────────────────────

  /**
   * Returns the aggregated tool list in MCP format with prefixed names.
   * Each tool gets an extra "server" field for routing info.
   */
  getTools() {
    const tools = [];

    // Built-in tools
    for (const tool of BUILTIN_TOOLS) {
      tools.push(tool);
    }

    // MCP server tools
    for (const [serverName, proc] of this.servers) {
      for (const tool of proc.tools) {
        tools.push({
          name: `${serverName}${SERVER_PREFIX_SEP}${tool.name}`,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          server: serverName,
        });
      }
    }
    return tools;
  }

  /**
   * Returns tools in OpenAI function-calling format (for Ollama `tools` param).
   */
  getToolsOpenAI() {
    return this.getTools().map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  // ─── Call routing ─────────────────────────────────────────────────────────

  /**
   * Route a prefixed tool call to the correct MCP server.
   * @param {string} prefixedName  e.g. "reminders__list_reminders"
   * @param {object} args
   * @returns {Promise<object>}    MCP tool result { content, isError }
   */
  async callTool(prefixedName, args) {
    let serverName, toolName;

    const sepIdx = prefixedName.indexOf(SERVER_PREFIX_SEP);
    if (sepIdx === -1) {
      // No prefix — try as builtin first, then fallback
      const builtinMatch = BUILTIN_TOOLS.find((t) => t.name === `builtin${SERVER_PREFIX_SEP}${prefixedName}`);
      if (builtinMatch) {
        serverName = 'builtin';
        toolName = prefixedName;
      } else {
        const err = new Error(
          `Tool name "${prefixedName}" is not recognized (expected format: "servername${SERVER_PREFIX_SEP}toolname")`
        );
        err.statusCode = 400;
        throw err;
      }
    } else {
      serverName = prefixedName.slice(0, sepIdx);
      toolName = prefixedName.slice(sepIdx + SERVER_PREFIX_SEP.length);
    }

    // Handle built-in tools
    if (serverName === 'builtin') {
      return await executeBuiltinTool(toolName, args);
    }

    const proc = this.servers.get(serverName);
    if (!proc) {
      const err = new Error(`Unknown server "${serverName}"`);
      err.statusCode = 400;
      throw err;
    }

    const result = await proc.callTool(toolName, args);
    return result;
  }
}

module.exports = { McpManager, getBraveKey, setBraveKey };
