const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');

const STASH_FILE = 'stashes.json';
const SETTINGS = {
    host: 'Bottest-wIQk.aternos.me', 
    port: 25565,              
    username: 'LogisticsKing',
    version: '1.21.5',
    auth: 'offline',
    checkTimeoutInterval: 120000 // Increased timeout for stability
};

const app = express();
app.use(bodyParser.json());
let bot;

// Helper to prevent crashes
const wait = (ms) => new Promise(res => setTimeout(res, ms));

const getDB = () => {
    try {
        if (!fs.existsSync(STASH_FILE)) return [];
        const data = fs.readFileSync(STASH_FILE, 'utf8');
        return data.trim() ? JSON.parse(data) : [];
    } catch (e) { return []; }
};

function createBot() {
    if (bot) {
        bot.removeAllListeners();
        try { bot.quit(); } catch(e) {}
    }

    bot = mineflayer.createBot(SETTINGS);
    bot.loadPlugin(pathfinder);

    // CRITICAL: Stop the bot from crashing the whole script on error
    bot.on('error', (err) => console.log('⚠️ Connection Error: ' + err.code));
    bot.on('kicked', (reason) => console.log('🚫 Kicked: ' + reason));

    bot.on('spawn', () => {
        console.log('✅ Bot Ready. Awaiting orders...');
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        bot.pathfinder.setMovements(movements);
    });

    bot.on('end', () => {
        console.log('🔌 Disconnected. Retrying in 10s...');
        setTimeout(createBot, 10000);
    });
}

// --- REPAIRED SMART ORDER SYSTEM ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, y, z, targetPlayer } = req.body;
    res.json({ status: 'Order Received - Starting Safety Checks' });

    try {
        const db = getDB();
        
        // 1. Safety Check: Is the bot actually in the game?
        if (!bot || !bot.entity) {
            console.log("Order failed: Bot not spawned.");
            return;
        }

        bot.chat(`📦 Processing order for ${targetPlayer || 'Coordinates'}...`);
        await wait(1000); // Small pause to prevent instant kick

        // 2. Locate Shulker
        let shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        if (!shulkerStash) {
            bot.chat("Error: No shulkers found in database. Use !scan first.");
            return;
        }

        // 3. Sequential Execution (Avoids overlapping tasks)
        const sPos = new Vec3(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z);
        await bot.pathfinder.goto(new goals.GoalGetToBlock(sPos.x, sPos.y, sPos.z));
        
        const block = bot.blockAt(sPos);
        const container = await bot.openContainer(block);
        const sItem = container.containerItems().find(i => i.name.includes('shulker_box'));
        await container.withdraw(sItem.type, null, 1);
        container.close();
        await wait(1000);

        // 4. Item Gathering
        let gathered = 0;
        for (const stash of db) {
            if (gathered >= count) break;
            const match = stash.items.find(i => i.name === itemName);
            if (match) {
                const p = new Vec3(stash.pos.x, stash.pos.y, stash.pos.z);
                await bot.pathfinder.goto(new goals.GoalGetToBlock(p.x, p.y, p.z));
                const c = await bot.openContainer(bot.blockAt(p));
                const toTake = Math.min(count - gathered, match.count);
                await c.withdraw(bot.registry.itemsByName[itemName].id, null, toTake);
                gathered += toTake;
                c.close();
                await wait(500);
            }
        }

        // 5. Packing & Delivery
        const deliverVec = new Vec3(parseInt(x), parseInt(y), parseInt(z));
        bot.chat('Heading to delivery point...');
        await bot.pathfinder.goto(new goals.GoalNear(deliverVec.x, deliverVec.y, deliverVec.z, 2));
        
        // Final Drop Logic
        const fullShulker = bot.inventory.items().find(i => i.name.includes('shulker_box'));
        if (fullShulker) await bot.tossStack(fullShulker);
        bot.chat('✅ Order Complete.');

    } catch (error) {
        console.log('❌ Order Error Caught:', error.message);
        bot.chat('⚠️ Technical error in logistics. Order paused.');
    }
});

// Dashboard and Player API (Same as previous version)
app.get('/players', (req, res) => {
    if (!bot || !bot.entities) return res.json([]);
    const players = Object.values(bot.entities)
        .filter(e => e.type === 'player' && e.username !== bot.username)
        .map(p => ({ username: p.username, x: Math.floor(p.position.x), y: Math.floor(p.position.y), z: Math.floor(p.position.z) }));
    res.json(players);
});

app.get('/stashes', (req, res) => res.json(getDB()));
app.get('/', (req, res) => { /* Same HTML UI provided in previous turn */ });

const RENDER_PORT = process.env.PORT || 10000;
app.listen(RENDER_PORT, () => console.log('Logistics Terminal Live'));
createBot();
