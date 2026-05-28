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
const fs = require('fs');
const path = require('path');

// ─── .env loader ─────────────────────────────────────────────────────────────
const ENV_FILE = path.join(__dirname, '.env');

function loadEnv() {
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] = match[2].trim();
    }
  } catch (_) { /* no .env yet, that's fine */ }
}
loadEnv();

const SERVER_PREFIX_SEP = '__';
const OSAURUS_URL = process.env.OSAURUS_URL || 'http://127.0.0.1:1337';
let osaurusKey = process.env.OSAURUS_ACCESS_KEY || '';
let osaurusToolsCache = null;
let osaurusToolsCacheTime = 0;
const OSAURUS_CACHE_TTL = 300000; // 5 minutes

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
  {
    name: 'builtin__shopping_list_to_pantry',
    description: 'Transfer all items from the Shopping List to the pantry. Fetches items from the Shopping List reminder, adds each to the pantry inventory, then marks them complete on the list. Use when the user says "add shopping list to pantry", "move shopping list to pantry", "I went shopping", or similar.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: {
          type: 'string',
          description: 'Name of the reminder list to transfer from (default: "Shopping List")',
        },
        clearList: {
          type: 'boolean',
          description: 'Whether to mark items as complete on the shopping list after adding to pantry (default: true)',
        },
      },
      required: [],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__organize_shopping_list',
    description: 'Organize shopping list items by grocery store section (Produce, Dairy, Meat, Bakery, Frozen, Canned/Dry, Condiments, Spices, Beverages, etc.). Returns items grouped by section for efficient shopping. Use when user says "organize my list", "sort by aisle", "make a shopping plan", or similar.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: {
          type: 'string',
          description: 'Name of the reminder list to organize (default: "Shopping List")',
        },
        saveAsNote: {
          type: 'boolean',
          description: 'Save the organized list as an Apple Note with checkboxes for offline use (default: false)',
        },
      },
      required: [],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__get_shopping_list',
    description: 'Get the current shopping list items. Returns just the item names — clean and easy to read. Use when the user asks what is on their shopping list, grocery list, or what they need to buy.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    server: 'builtin',
  },
  // ── Reminders tools (replacing Osaurus) ──
  {
    name: 'builtin__get_reminders',
    description: 'Get reminders, optionally filtered by list name. Returns title, completion status, due date, and notes for each reminder. Use when the user asks about their reminders, to-do items, or what they need to do.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: {
          type: 'string',
          description: 'Filter by reminder list name (e.g. "Shopping List", "Work"). Omit to get reminders from all lists.',
        },
        includeCompleted: {
          type: 'boolean',
          description: 'Include completed reminders (default: false)',
        },
      },
      required: [],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__get_lists',
    description: 'Get the names of all reminder lists. Use when the user asks what lists they have or wants to see available reminder lists.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__create_reminder',
    description: 'Create a new reminder. Use when the user asks to add a reminder, set a to-do, or remember something.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The reminder title / text',
        },
        listName: {
          type: 'string',
          description: 'List to add the reminder to (default: "Reminders")',
        },
        notes: {
          type: 'string',
          description: 'Additional notes for the reminder',
        },
      },
      required: ['title'],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__search_reminders',
    description: 'Search reminders by title. Use when the user asks to find a specific reminder or asks "do I have a reminder about..."',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for in reminder titles',
        },
      },
      required: ['query'],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__open_reminder',
    description: 'Open the Reminders app. Use when the user says "open reminders" or wants to see their reminders visually.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    server: 'builtin',
  },
  // ── Notes tools ──
  {
    name: 'builtin__list_notes',
    description: 'List recent notes from Apple Notes. Use when the user asks what notes they have, to see their notes, or find a specific note.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    server: 'builtin',
  },
  // ── Filesystem tools ──
  {
    name: 'builtin__list_directory',
    description: 'List contents of a directory on the Mac. Use when the user asks what files are in a folder, or wants to browse directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list (default: current directory)',
        },
      },
      required: [],
    },
    server: 'builtin',
  },
];

async function executeBuiltinTool(toolName, args, manager) {
  if (toolName === 'web_search') {
    return await braveSearch(args.query, args.count || 5);
  }
  if (toolName === 'weather_search') {
    return await weatherSearch(args.query);
  }
  if (toolName === 'crypto_price') {
    return await cryptoPrice(args.coins, args.currency);
  }
  if (toolName === 'shopping_list_to_pantry') {
    return await shoppingListToPantry(args.listName || 'Shopping List', args.clearList !== false, manager);
  }
  if (toolName === 'organize_shopping_list') {
    return await organizeShoppingList(args.listName || 'Shopping List', args.saveAsNote || false, manager);
  }
  if (toolName === 'get_shopping_list') {
    return await getShoppingList(manager);
  }
  // ── Osaurus replacements ──
  if (toolName === 'get_reminders') {
    return await getReminders(args.listName, args.includeCompleted, manager);
  }
  if (toolName === 'get_lists') {
    return await getLists();
  }
  if (toolName === 'create_reminder') {
    return await createReminder(args.title, args.listName, args.notes);
  }
  if (toolName === 'search_reminders') {
    return await searchReminders(args.query);
  }
  if (toolName === 'open_reminder') {
    return await openReminder();
  }
  if (toolName === 'list_notes') {
    return await listNotes();
  }
  if (toolName === 'list_directory') {
    return await listDirectory(args.path);
  }
  throw Object.assign(new Error(`Unknown builtin tool: ${toolName}`), { statusCode: 400 });
}

async function shoppingListToPantry(listName, clearList, manager) {
  const results = [];
  const errors = [];

  try {
    // Step 1: Get items from shopping list
    results.push(`Fetching items from "${listName}"...`);
    const listResult = await manager.callTool('reminders__get_reminders', { listName });

    if (listResult.isError) {
      return {
        content: [{ type: 'text', text: `Failed to get shopping list: ${listResult.content?.[0]?.text || 'Unknown error'}` }],
        isError: true,
      };
    }

    // Parse the reminder items from the response
    let reminders = [];
    try {
      const responseText = listResult.content?.[0]?.text || '{}';
      const parsed = JSON.parse(responseText);
      reminders = parsed.reminders || [];
    } catch (parseErr) {
      return {
        content: [{ type: 'text', text: `Failed to parse shopping list response: ${parseErr.message}` }],
        isError: true,
      };
    }

    if (reminders.length === 0) {
      return {
        content: [{ type: 'text', text: `Shopping list "${listName}" is empty. Nothing to transfer.` }],
        isError: false,
      };
    }

    results.push(`Found ${reminders.length} items. Adding to pantry...`);

    // Step 2: Add each item to pantry — track which ones succeed
    let addedCount = 0;
    const successfullyAdded = []; // Track items that made it to pantry
    
    for (const reminder of reminders) {
      const itemName = reminder.name || reminder.title || '';
      if (!itemName) continue;

      try {
        const addResult = await manager.callTool('pantry__pantry_add_item', {
          name: itemName,
          quantity: 1,
          unit: 'item',
          notes: 'Added from shopping list',
        });
        if (addResult.isError) {
          errors.push(`Failed to add "${itemName}" to pantry: ${addResult.content?.[0]?.text || 'Unknown error'}`);
        } else {
          addedCount++;
          successfullyAdded.push(reminder); // Only track successful adds
        }
      } catch (addErr) {
        errors.push(`Error adding "${itemName}": ${addErr.message}`);
      }
    }

    results.push(`Added ${addedCount} of ${reminders.length} items to pantry.`);

    // Step 3: ONLY clear items that were successfully added to pantry
    let clearedCount = 0;
    if (clearList && successfullyAdded.length > 0) {
      results.push('Clearing successfully added items from shopping list...');
      for (const reminder of successfullyAdded) {
        const reminderId = reminder.id;
        if (!reminderId) continue;

        try {
          const completeResult = await manager.callTool('reminders__complete_reminder', {
            id: reminderId,
            listName: listName,
          });
          if (!completeResult.isError) {
            clearedCount++;
          }
        } catch (clearErr) {
          // Non-critical error, just log it
          console.error(`[shopping_list_to_pantry] Failed to clear reminder ${reminderId}:`, clearErr.message);
        }
      }
      results.push(`Cleared ${clearedCount} items from shopping list.`);
    }

    // Build summary
    const summary = [
      '**Shopping List → Pantry Transfer Complete**',
      '',
      `✓ ${addedCount} items added to pantry`,
      clearList ? `✓ ${clearedCount} items cleared from shopping list` : '(Items left on shopping list)',
      '',
    ];

    if (errors.length > 0) {
      summary.push('**Errors:**');
      errors.forEach(e => summary.push(`• ${e}`));
      summary.push('');
    }

    summary.push('Items transferred:');
    reminders.forEach(r => summary.push(`• ${r.name || r.title}`));

    return {
      content: [{ type: 'text', text: summary.join('\n') }],
      isError: false,
    };

  } catch (err) {
    return {
      content: [{ type: 'text', text: `Shopping list transfer failed: ${err.message}` }],
      isError: true,
    };
  }
}

async function organizeShoppingList(listName, saveAsNote, manager) {
  try {
    // Get items from shopping list
    const listResult = await manager.callTool('reminders__get_reminders', { listName });

    if (listResult.isError) {
      return {
        content: [{ type: 'text', text: `Failed to get shopping list: ${listResult.content?.[0]?.text || 'Unknown error'}` }],
        isError: true,
      };
    }

    // Parse the reminder items
    let reminders = [];
    try {
      const responseText = listResult.content?.[0]?.text || '{}';
      const parsed = JSON.parse(responseText);
      reminders = parsed.reminders || [];
    } catch (parseErr) {
      return {
        content: [{ type: 'text', text: `Failed to parse shopping list: ${parseErr.message}` }],
        isError: true,
      };
    }

    if (reminders.length === 0) {
      return {
        content: [{ type: 'text', text: `Shopping list "${listName}" is empty.` }],
        isError: false,
      };
    }

    // Category definitions with keywords
    const categories = {
      '🥬 Produce': [
        'apple', 'banana', 'orange', 'lemon', 'lime', 'grape', 'strawberry', 'blueberry', 'raspberry',
        'avocado', 'tomato', 'potato', 'onion', 'garlic', 'ginger', 'pepper', 'jalapeño', 'jalapeno',
        'lettuce', 'spinach', 'kale', 'cabbage', 'carrot', 'celery', 'cucumber', 'zucchini', 'squash',
        'broccoli', 'cauliflower', 'corn', 'peas', 'beans', 'mushroom', 'asparagus', 'artichoke',
        'basil', 'cilantro', 'parsley', 'rosemary', 'thyme', 'mint', 'dill', 'chives',
        'melon', 'watermelon', 'pineapple', 'mango', 'peach', 'pear', 'plum', 'cherry',
        'pearl onion', 'yellow onion', 'red onion', 'white onion', 'sweet onion',
      ],
      '🥩 Meat & Seafood': [
        'beef', 'steak', 'ground beef', 'chuck', 'sirloin', 'ribeye', 'filet',
        'chicken', 'turkey', 'duck', 'hen',
        'pork', 'bacon', 'ham', 'sausage', 'prosciutto', 'pancetta', 'chorizo',
        'lamb', 'veal', 'bison', 'venison',
        'salmon', 'tuna', 'shrimp', 'crab', 'lobster', 'tilapia', 'cod', 'halibut', 'trout',
        'fish', 'scallops', 'mussels', 'clams', 'oysters',
      ],
      '🥛 Dairy & Eggs': [
        'milk', 'cream', 'half and half', 'heavy cream', 'whipping cream',
        'butter', 'margarine',
        'cheese', 'cheddar', 'mozzarella', 'parmesan', 'swiss', 'gouda', 'brie', 'feta', 'ricotta',
        'cream cheese', 'sour cream', 'yogurt', 'kefir',
        'egg', 'eggs',
        'ice cream', 'gelato', 'frozen yogurt',
      ],
      '🍞 Bakery': [
        'bread', 'roll', 'bun', 'bagel', 'muffin', 'croissant', 'baguette', 'sourdough',
        'tortilla', 'pita', 'naan', 'flatbread',
        'cake', 'pie', 'pastry', 'donut', 'cookie', 'brownie',
        'hawaiian roll', 'kings hawaiian', 'king\'s hawaiian',
        'flour', 'cornmeal', 'corn starch', 'baking powder', 'baking soda', 'yeast',
      ],
      '🧊 Frozen': [
        'frozen', 'ice cream', 'pizza', 'waffle', 'fries', 'tater tots',
        'vegetables frozen', 'frozen fruit', 'frozen vegetable',
        'fish sticks', 'chicken nuggets', 'chicken strips',
        'ice', 'popsicle', 'sorbet',
      ],
      '🥫 Canned & Dry Goods': [
        'can', 'canned', 'beans canned', 'tomato sauce', 'tomato paste', 'diced tomato',
        'soup', 'broth', 'stock', 'beef broth', 'chicken broth',
        'rice', 'pasta', 'noodle', 'spaghetti', 'penne', 'rigatoni', 'macaroni',
        'cereal', 'oat', 'oatmeal', 'granola',
        'bean', 'lentil', 'chickpea', 'split pea',
        'peanut butter', 'jelly', 'jam', 'preserves',
        'oil', 'olive oil', 'vegetable oil', 'coconut oil', 'avocado oil', 'sesame oil',
        'vinegar', 'soy sauce', 'hot sauce', 'ketchup', 'mustard', 'mayonnaise',
        'salt', 'pepper', 'sugar', 'honey', 'syrup', 'maple syrup',
        'spice', 'seasoning', 'cumin', 'paprika', 'chili powder', 'oregano', 'basil dried',
        'cinnamon', 'nutmeg', 'garlic powder', 'onion powder', 'turmeric', 'curry',
        'corn starch', 'baking powder', 'baking soda', 'vanilla extract',
        'noodle', 'ramen', 'pasta sauce', 'spaghetti sauce',
        'tea', 'coffee', 'cocoa',
        'nut', 'almond', 'walnut', 'pecan', 'cashew', 'peanut',
        'seed', 'sunflower', 'pumpkin', 'sesame',
        'cracker', 'chip', 'pretzel', 'popcorn',
        'cookie', 'candy', 'chocolate',
      ],
      '🧴 Condiments & Sauces': [
        'ketchup', 'mustard', 'mayo', 'mayonnaise', 'relish', 'hot sauce', 'sriracha',
        'soy sauce', 'worcestershire', 'teriyaki', 'barbecue', 'bbq',
        'salsa', 'guacamole', 'hummus', 'dip',
        'dressing', 'ranch', 'vinaigrette', 'italian dressing',
        'jam', 'jelly', 'preserves', 'marmalade',
        'honey', 'syrup', 'maple', 'molasses',
        'pickle', 'olive', 'caper', 'anchovy',
        'cooking spray', 'non-stick spray',
      ],
      '🧀 Deli & Prepared': [
        'deli', 'lunch meat', 'ham sliced', 'turkey sliced', 'roast beef sliced',
        'salami', 'bologna', 'prosciutto',
        'prepared', 'rotisserie', 'salad prepared',
        'dip', 'hummus', 'guacamole', 'salsa',
        'sushi', 'sandwich', 'wrap',
      ],
      '🥤 Beverages': [
        'water', 'juice', 'soda', 'pop', 'cola', 'sprite', 'pepsi', 'coke',
        'beer', 'wine', 'alcohol', 'liquor', 'spirits',
        'tea', 'coffee', 'espresso', 'latte',
        'milk', 'almond milk', 'soy milk', 'oat milk', 'coconut milk',
        'lemonade', 'punch', 'smoothie',
        'sparkling', 'seltzer', 'tonic',
      ],
      '🧹 Household & Cleaning': [
        'paper towel', 'toilet paper', 'tissue', 'napkin',
        'soap', 'detergent', 'dish soap', 'laundry',
        'cleaner', 'bleach', 'disinfectant', 'wipes',
        'trash bag', 'garbage bag', 'storage bag', 'ziplock',
        'aluminum foil', 'plastic wrap', 'parchment paper',
        'sponge', 'brush', 'broom', 'mop',
      ],
      '🐾 Pet Supplies': [
        'dog', 'cat', 'pet', 'pet food', 'dog food', 'cat food',
        'treat', 'bone', 'chew',
        'litter', 'collar', 'leash',
      ],
      '💊 Health & Beauty': [
        'shampoo', 'conditioner', 'soap', 'body wash', 'deodorant',
        'toothpaste', 'toothbrush', 'mouthwash', 'floss',
        'lotion', 'sunscreen', 'moisturizer',
        'vitamin', 'supplement', 'medicine', 'aspirin', 'ibuprofen',
        'bandage', 'first aid',
      ],
    };

    // Categorize each item
    const categorized = {};
    const uncategorized = [];

    for (const reminder of reminders) {
      const itemName = (reminder.name || reminder.title || '').toLowerCase();
      let found = false;

      // Check each category
      for (const [category, keywords] of Object.entries(categories)) {
        for (const keyword of keywords) {
          if (itemName.includes(keyword)) {
            if (!categorized[category]) categorized[category] = [];
            categorized[category].push(reminder.name || reminder.title);
            found = true;
            break;
          }
        }
        if (found) break;
      }

      if (!found) {
        uncategorized.push(reminder.name || reminder.title);
      }
    }

    // Build the organized list
    const sectionOrder = [
      '🥬 Produce',
      '🥩 Meat & Seafood',
      '🥛 Dairy & Eggs',
      '🍞 Bakery',
      '🧀 Deli & Prepared',
      '🥫 Canned & Dry Goods',
      '🧴 Condiments & Sauces',
      '🧊 Frozen',
      '🥤 Beverages',
      '🧹 Household & Cleaning',
      '🐾 Pet Supplies',
      '💊 Health & Beauty',
    ];

    const output = [
      `**🛒 Shopping List — Organized by Section**`,
      `*${reminders.length} items total*`,
      '',
    ];

    let itemCount = 0;
    for (const section of sectionOrder) {
      const items = categorized[section];
      if (items && items.length > 0) {
        output.push(`**${section}** (${items.length})`);
        items.forEach(item => {
          itemCount++;
          output.push(`  ☐ ${item}`);
        });
        output.push('');
      }
    }

    // Add uncategorized items
    if (uncategorized.length > 0) {
      output.push(`**📦 Other** (${uncategorized.length})`);
      uncategorized.forEach(item => {
        itemCount++;
        output.push(`  ☐ ${item}`);
      });
      output.push('');
    }

    output.push('---');
    output.push('*Pro tip: Start at Produce, work your way through the store sections. Check items off as you go!*');

    const resultText = output.join('\n');

    // Save as Apple Note if requested
    if (saveAsNote) {
      try {
        // Build note content with checkboxes
        const noteLines = [
          `**🛒 Shopping List — Organized by Section**`,
          `*${reminders.length} items — ${new Date().toLocaleDateString()}*`,
          '',
        ];

        for (const section of sectionOrder) {
          const items = categorized[section];
          if (items && items.length > 0) {
            noteLines.push(`**${section}**`);
            items.forEach(item => {
              noteLines.push(`☐ ${item}`);
            });
            noteLines.push('');
          }
        }

        if (uncategorized.length > 0) {
          noteLines.push('**📦 Other**');
          uncategorized.forEach(item => {
            noteLines.push(`☐ ${item}`);
          });
          noteLines.push('');
        }

        const noteContent = noteLines.join('\n');
        const noteTitle = `Shopping List — ${new Date().toLocaleDateString()}`;

        // Call Apple Notes MCP tool
        const noteResult = await manager.callTool('notes__create-note', {
          title: noteTitle,
          content: noteContent,
          format: 'plaintext',
        });

        if (noteResult.isError) {
          return {
            content: [{ type: 'text', text: `${resultText}\n\n⚠️ Failed to save as note: ${noteResult.content?.[0]?.text || 'Unknown error'}` }],
            isError: false,
          };
        }

        return {
          content: [{ type: 'text', text: `${resultText}\n\n✅ Saved as Apple Note: "${noteTitle}"\nOpen Notes app to check items off offline!` }],
          isError: false,
        };
      } catch (noteErr) {
        return {
          content: [{ type: 'text', text: `${resultText}\n\n⚠️ Failed to save as note: ${noteErr.message}` }],
          isError: false,
        };
      }
    }

    return {
      content: [{ type: 'text', text: resultText }],
      isError: false,
    };

  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to organize shopping list: ${err.message}` }],
      isError: true,
    };
  }
}

async function getShoppingList(manager) {
  try {
    const items = await getRemindersFromCLI('Shopping List', false);
    if (items.length === 0) {
      return {
        content: [{ type: 'text', text: 'Your shopping list is currently empty.' }],
        isError: false,
      };
    }
    const titles = items.map(i => `• ${i.title}`);
    return {
      content: [{ type: 'text', text: `Shopping List (${items.length} items):\n${titles.join('\n')}` }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to get shopping list: ${err.message}` }],
      isError: true,
    };
  }
}

// ── Osaurus replacements: remindctl wrapper ──

async function getRemindersFromCLI(listName, includeCompleted) {
  const { execSync } = require('child_process');
  let cmd;
  if (listName) {
    cmd = `remindctl list "${listName}" --json`;
  } else {
    // For all lists, we need to get each list and aggregate
    const listCmd = `remindctl list --json`;
    const listsOut = execSync(listCmd, { encoding: 'utf8', timeout: 15000 });
    const lists = JSON.parse(listsOut);
    const allItems = [];
    for (const l of lists) {
      try {
        const itemsOut = execSync(`remindctl list "${l.title}" --json`, { encoding: 'utf8', timeout: 10000 });
        const items = JSON.parse(itemsOut);
        allItems.push(...items);
      } catch (e) {
        // Skip lists that fail
      }
    }
    const filtered = includeCompleted ? allItems : allItems.filter(i => !i.isCompleted);
    return filtered;
  }
  const out = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
  const items = JSON.parse(out);
  return includeCompleted ? items : items.filter(i => !i.isCompleted);
}

async function getReminders(listName, includeCompleted, manager) {
  try {
    const items = await getRemindersFromCLI(listName, includeCompleted === true);
    if (items.length === 0) {
      const scope = listName ? `in "${listName}"` : '';
      return {
        content: [{ type: 'text', text: `No reminders found ${scope}.` }],
        isError: false,
      };
    }
    const lines = items.map(i => {
      const check = i.isCompleted ? '✓' : '☐';
      const due = i.dueDate ? ` (due: ${i.dueDate.split('T')[0]})` : '';
      const note = i.notes ? ` — ${i.notes.substring(0, 80)}` : '';
      const list = i.listName ? ` [${i.listName}]` : '';
      return `${check} ${i.title}${list}${due}${note}`;
    });
    return {
      content: [{ type: 'text', text: `Reminders (${items.length}):\n${lines.join('\n')}` }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to get reminders: ${err.message}` }],
      isError: true,
    };
  }
}

async function getLists() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('remindctl list --json', { encoding: 'utf8', timeout: 10000 });
    const lists = JSON.parse(out);
    const lines = lists.map(l => `• ${l.title} (${l.reminderCount || 0} reminders)`);
    return {
      content: [{ type: 'text', text: `Reminder Lists (${lists.length}):\n${lines.join('\n')}` }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to get lists: ${err.message}` }],
      isError: true,
    };
  }
}

async function createReminder(title, listName, notes) {
  try {
    const { execSync } = require('child_process');
    let cmd = `remindctl add "${title.replace(/"/g, '\\"')}"`;
    if (listName) cmd += ` --list "${listName.replace(/"/g, '\\"')}"`;
    if (notes) cmd += ` --notes "${notes.replace(/"/g, '\\"').substring(0, 500)}"`;
    const out = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
    return {
      content: [{ type: 'text', text: `✅ Created reminder: "${title}"${listName ? ` in "${listName}"` : ''}` }],
      isError: false,
    };
  } catch (err) {
    const msg = err.stderr || err.message;
    return {
      content: [{ type: 'text', text: `Failed to create reminder: ${msg.substring(0, 300)}` }],
      isError: true,
    };
  }
}

async function searchReminders(query) {
  try {
    const items = await getRemindersFromCLI(null, false);
    const q = query.toLowerCase();
    const matches = items.filter(i => i.title && i.title.toLowerCase().includes(q));
    if (matches.length === 0) {
      return {
        content: [{ type: 'text', text: `No reminders found matching "${query}".` }],
        isError: false,
      };
    }
    const lines = matches.map(i => {
      const list = i.listName ? ` [${i.listName}]` : '';
      return `• ${i.title}${list}`;
    });
    return {
      content: [{ type: 'text', text: `Found ${matches.length} reminder(s) matching "${query}":\n${lines.join('\n')}` }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to search reminders: ${err.message}` }],
      isError: true,
    };
  }
}

async function openReminder() {
  try {
    const { execSync } = require('child_process');
    execSync('open x-apple-reminderkit://', { timeout: 5000 });
    return {
      content: [{ type: 'text', text: 'Opened Reminders app.' }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to open Reminders: ${err.message}` }],
      isError: true,
    };
  }
}

async function listNotes() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('memo notes --no-cache', { encoding: 'utf8', timeout: 15000 });
    // memo output format: "1. Note Title  2. Note Title  ..." or similar
    // Clean it up
    const lines = out.split('\n').filter(l => l.trim()).slice(0, 20);
    if (lines.length === 0) {
      return {
        content: [{ type: 'text', text: 'No notes found.' }],
        isError: false,
      };
    }
    return {
      content: [{ type: 'text', text: `Notes:\n${lines.join('\n')}` }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to list notes: ${err.message}` }],
      isError: true,
    };
  }
}

async function listDirectory(dirPath) {
  try {
    const { execSync } = require('child_process');
    const target = dirPath || process.cwd();
    const out = execSync(`ls -lh "${target}"`, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    return {
      content: [{ type: 'text', text: `Contents of ${target}:\n${out.trim()}` }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to list directory: ${err.message}` }],
      isError: true,
    };
  }
}

async function executeCustomTool(toolName, args) {
  try {
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');
    const customPath = path.join(__dirname, 'custom-tools.json');
    if (!fs.existsSync(customPath)) {
      return { content: [{ type: 'text', text: 'No custom tools defined.' }], isError: true };
    }
    const tools = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    const tool = tools.find(t => t.name === `custom__${toolName}`);
    if (!tool) {
      return { content: [{ type: 'text', text: `Custom tool "${toolName}" not found.` }], isError: true };
    }
    // Substitute args into command — $ARG_NAME gets replaced
    let cmd = tool.command;
    for (const [key, val] of Object.entries(args || {})) {
      cmd = cmd.replace(new RegExp(`\\$\\{?${key}\\}?`, 'g'), String(val));
    }
    const out = execSync(cmd, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    return {
      content: [{ type: 'text', text: out.trim() || '(no output)' }],
      isError: false,
    };
  } catch (err) {
    const msg = err.stderr || err.message;
    return {
      content: [{ type: 'text', text: `Tool failed: ${msg.substring(0, 500)}` }],
      isError: true,
    };
  }
}

async function fetchOsaurusTools() {
  if (osaurusToolsCache && (Date.now() - osaurusToolsCacheTime) < OSAURUS_CACHE_TTL) {
    return osaurusToolsCache;
  }
  if (!osaurusKey) {
    console.warn(`[${ts()}] [manager] Osaurus key not configured, skipping Osaurus tools`);
    return [];
  }
  try {
    const result = await httpGet(`${OSAURUS_URL}/mcp/tools`, {
      'Authorization': `Bearer ${osaurusKey}`,
      'Accept': 'application/json',
    });
    const data = JSON.parse(result);
    const tools = data.tools || [];
    osaurusToolsCache = tools;
    osaurusToolsCacheTime = Date.now();
    console.log(`[${ts()}] [manager] Fetched ${tools.length} Osaurus tools`);
    return tools;
  } catch (err) {
    console.error(`[${ts()}] [manager] Failed to fetch Osaurus tools: ${err.message}`);
    return osaurusToolsCache || []; // return stale cache if available
  }
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    lib.get(url, { headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

function httpPostJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const bodyStr = JSON.stringify(body);
    const allHeaders = { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) };
    const req = lib.request(url, { method: 'POST', headers: allHeaders, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ content: [{ type: 'text', text: data }], isError: res.statusCode >= 400 });
        }
      });
    });
    req.on('error', (err) => resolve({ content: [{ type: 'text', text: `Osaurus proxy error: ${err.message}` }], isError: true }));
    req.write(bodyStr);
    req.end();
  });
}

function getOsaurusKey() { return osaurusKey; }
function setOsaurusKey(key) {
  osaurusKey = key;
  osaurusToolsCache = null; // invalidate cache on key change
  try {
    let envContent = '';
    try { envContent = fs.readFileSync(ENV_FILE, 'utf8'); } catch (_) {}
    const lines = envContent.split('\n').filter(l => !l.startsWith('OSAURUS_ACCESS_KEY='));
    lines.push(`OSAURUS_ACCESS_KEY=${key}`);
    fs.writeFileSync(ENV_FILE, lines.join('\n').replace(/\n+$/, '') + '\n', 'utf8');
  } catch (e) {
    console.error('[mcp-manager] Failed to persist Osaurus key to .env:', e.message);
  }
}

function getBraveKey() { return braveKey; }
function setBraveKey(key) {
  braveKey = key;
  // Persist to .env so it survives bridge restarts
  try {
    let envContent = '';
    try { envContent = fs.readFileSync(ENV_FILE, 'utf8'); } catch (_) {}
    const lines = envContent.split('\n').filter(l => !l.startsWith('BRAVE_SEARCH_API_KEY='));
    lines.push(`BRAVE_SEARCH_API_KEY=${key}`);
    fs.writeFileSync(ENV_FILE, lines.join('\n').replace(/\n+$/, '') + '\n', 'utf8');
  } catch (e) {
    console.error('[mcp-manager] Failed to persist Brave key to .env:', e.message);
  }
}

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
  async getTools() {
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

    // Custom tools (from custom-tools.json)
    try {
      const customPath = require('path').join(__dirname, 'custom-tools.json');
      if (require('fs').existsSync(customPath)) {
        const customTools = JSON.parse(require('fs').readFileSync(customPath, 'utf8'));
        for (const tool of customTools) {
          tools.push(tool);
        }
      }
    } catch (e) {
      // custom-tools.json doesn't exist or is invalid — skip
    }

    return tools;
  }

  /**
   * Returns tools in OpenAI function-calling format (for Ollama `tools` param).
   */
  async getToolsOpenAI() {
    const tools = await this.getTools();
    return tools.map((tool) => ({
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
      return await executeBuiltinTool(toolName, args, this);
    }

    // Handle custom tools
    if (serverName === 'custom') {
      return await executeCustomTool(toolName, args);
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
