const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const fs = require('fs');
const express = require('express');
const path = require('path');

const app = express();
const STASH_FILE = 'stashes.json';

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 12345, // UPDATE PER POJAV SESSION
  username: 'LogisticsPro',
  version: '1.20.4',
  auth: 'offline',
  checkTimeoutInterval: 120000 // Higher timeout for long travels
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock);

bot.on('spawn', () => {
    bot.chat("System Online. Starting 500-block sweep...");
    startSpiralScan(); 
});

// --- SPIRAL SCAN LOGIC ---
async function startSpiralScan() {
    const range = 500;
    const step = 16; // One chunk at a time
    for (let i = 0; i < range; i += step) {
        // Move bot to new chunk to load it
        const nextPoint = new goals.GoalNear(bot.entity.position.x + i, bot.entity.position.y, bot.entity.position.z + i, 2);
        bot.pathfinder.setGoal(nextPoint);
        
        // While moving, scan for chests
        const chests = bot.findBlocks({
            matching: b => b.name.includes('chest'),
            maxDistance: 32,
            count: 10
        });

        for (const pos of chests) {
            await recordChest(pos);
        }
    }
}

async function recordChest(pos) {
    const chestBlock = bot.blockAt(pos);
    const chest = await bot.openChest(chestBlock);
    const items = chest.items().map(i => ({ name: i.name, count: i.count }));
    
    let db = fs.existsSync(STASH_FILE) ? JSON.parse(fs.readFileSync(STASH_FILE)) : [];
    const index = db.findIndex(s => s.pos.x === pos.x && s.pos.z === pos.z);
    
    if (index === -1) {
        db.push({ pos: pos, items: items });
        bot.chat(`Mapped new stash at ${pos.x}, ${pos.z}`);
    }
    fs.writeFileSync(STASH_FILE, JSON.stringify(db, null, 2));
    chest.close();
}

// --- WEB API ---
app.get('/stashes', (req, res) => res.json(JSON.parse(fs.readFileSync(STASH_FILE) || '[]')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/order/:item', async (req, res) => {
    const stashes = JSON.parse(fs.readFileSync(STASH_FILE));
    const target = stashes.find(s => s.items.some(i => i.name.includes(req.params.item)));
    if (target) {
        bot.chat(`Heading to stash at ${target.pos.x}, ${target.pos.z}...`);
        await bot.pathfinder.goto(new goals.GoalBlock(target.pos.x, target.pos.y, target.pos.z));
        // Logic to withdraw and return to player would go here
    }
});

app.listen(8080);

// Auto-Reconnect
bot.on('end', () => {
    console.log("Disconnected. Reconnecting...");
    setTimeout(() => { process.exit(); }, 5000); // Process manager (like pm2) would restart this
});
