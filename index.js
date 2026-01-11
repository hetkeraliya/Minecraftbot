const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const fs = require('fs');
const express = require('express');
const path = require('path');

const app = express();
const STASH_FILE = 'stashes.json';

// --- CONFIGURATION ---
// IMPORTANT: Update these with your current ngrok address!
const settings = {
  host: '0.tcp.ngrok.io', // Your ngrok host
  port: 12345,            // Your ngrok port
  username: 'LogisticsKing',
  version: '1.20.4',      // Match your Pojav version
  auth: 'offline',
  checkTimeoutInterval: 120000 
};

let bot;

function startBot() {
  bot = mineflayer.createBot(settings);

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlock);

  bot.on('spawn', () => {
    console.log("Bot joined the game!");
    bot.chat("System Online. Starting 500-block spiral scan...");
    startSpiralScan(bot);
  });

  // --- SPIRAL SCAN LOGIC (500 BLOCKS) ---
  async function startSpiralScan(bot) {
    let x = 0, z = 0, dx = 0, dz = -1;
    const stepSize = 24; // Distance between scan points
    const maxSteps = Math.pow(500 / stepSize, 2);

    for (let i = 0; i < maxSteps; i++) {
      const targetPos = bot.entity.position.offset(x, 0, z);
      const mcData = require('minecraft-data')(bot.version);
      bot.pathfinder.setMovements(new Movements(bot, mcData));
      
      try {
        // Walk to the next chunk to load it
        await bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2));
        
        // Scan for chests in this new area
        const chests = bot.findBlocks({
          matching: b => b.name.includes('chest'),
          maxDistance: 32,
          count: 5
        });

        for (const pos of chests) {
          await recordChest(bot, pos);
        }
      } catch (e) {
        console.log("Scanning paused or interrupted.");
      }

      // Spiral math
      if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) {
        [dx, dz] = [-dz, dx];
      }
      x += dx * stepSize;
      z += dz * stepSize;
    }
  }

  async function recordChest(bot, pos) {
    try {
      const chestBlock = bot.blockAt(pos);
      const chest = await bot.openChest(chestBlock);
      const items = chest.items().map(i => ({ name: i.name, count: i.count }));
      
      let db = fs.existsSync(STASH_FILE) ? JSON.parse(fs.readFileSync(STASH_FILE)) : [];
      const index = db.findIndex(s => s.pos.x === pos.x && s.pos.z === pos.z);
      
      if (index > -1) db[index].items = items;
      else db.push({ pos: pos, items: items });

      fs.writeFileSync(STASH_FILE, JSON.stringify(db, null, 2));
      bot.chat(`Updated Map: Stash found at ${pos.x}, ${pos.z}`);
      chest.close();
    } catch (err) { /* Chest is likely blocked */ }
  }

  // --- AUTO-RECONNECT ---
  bot.on('end', (reason) => {
    console.log(`Disconnected: ${reason}. Retrying in 10 seconds...`);
    setTimeout(startBot, 10000);
  });

  bot.on('error', (err) => console.log("Bot Error:", err.message));
}

// --- WEB SERVER FOR RENDER ---
app.get('/stashes', (req, res) => {
  const data = fs.existsSync(STASH_FILE) ? fs.readFileSync(STASH_FILE) : '[]';
  res.json(JSON.parse(data));
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.get('/order/:item', (req, res) => {
  bot.chat(`Order received for ${req.params.item}! Processing...`);
  res.send("Order sent to bot.");
});

// Render provides the port automatically
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Dashboard live on port ${PORT}`);
});

startBot();
                    
