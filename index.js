const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');

// --- CONFIGURATION ---
const STASH_FILE = 'stashes.json';
const SETTINGS = {
    host: 'Bottest-wIQk.aternos.me', 
    port: 25565,              
    username: 'LogisticsKing',
    version: '1.21.5',
    auth: 'offline',
    checkTimeoutInterval: 120000 
};

const app = express();
app.use(bodyParser.json());
let bot;

// Helper: Safety Wait
const wait = (ms) => new Promise(res => setTimeout(res, ms));

// Helper: Force clean Vec3 objects from raw data
const toVec = (pos) => new Vec3(Number(pos.x), Number(pos.y), Number(pos.z));

// Database: Load/Save stashes.json
const getDB = () => {
    try {
        if (!fs.existsSync(STASH_FILE)) return [];
        const data = fs.readFileSync(STASH_FILE, 'utf8');
        return data.trim() ? JSON.parse(data) : [];
    } catch (e) { return []; }
};
const saveDB = (data) => fs.writeFileSync(STASH_FILE, JSON.stringify(data, null, 2));

function createBot() {
    if (bot) bot.removeAllListeners();
    bot = mineflayer.createBot(SETTINGS);
    bot.loadPlugin(pathfinder);

    bot.on('error', (err) => console.log('📡 Network Alert: ' + err.code));
    bot.on('kicked', (reason) => console.log('🚫 Kicked: ' + reason));

    bot.on('spawn', () => {
        console.log('✅ Logistics King Online');
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        movements.canDig = true;           
        movements.canPlaceOn = true;      
        bot.pathfinder.setMovements(movements);
    });

    // --- AGGRESSIVE SCANNER (!scan) ---
    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;
        if (message === '!scan') {
            bot.chat('🔍 Scanning warehouse (64 block radius)...');
            const containers = bot.findBlocks({
                matching: b => ['chest', 'shulker_box', 'barrel', 'trapped_chest'].some(n => b.name.includes(n)),
                maxDistance: 64, count: 100
            });

            if (containers.length === 0) return bot.chat('❌ No chests found!');
            
            let db = [];
            for (const pos of containers) {
                try {
                    const target = toVec(pos);
                    await bot.pathfinder.goto(new goals.GoalGetToBlock(target.x, target.y, target.z));
                    await wait(800);
                    const container = await bot.openContainer(bot.blockAt(target));
                    const items = container.containerItems().map(i => ({ name: i.name, count: i.count }));
                    db.push({ pos: {x: target.x, y: target.y, z: target.z}, items });
                    saveDB(db);
                    container.close();
                    await wait(300);
                } catch (e) { console.log('Skipped chest at ' + pos); }
            }
            bot.chat('✅ Scan Complete. Dashboard updated.');
        }
    });

    bot.on('end', () => setTimeout(createBot, 10000));
}

// --- ORDER & DELIVERY LOGIC ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, y, z } = req.body;
    const targetQty = parseInt(count) || 64;
    const dest = { x: Number(x), y: Number(y), z: Number(z) };

    res.json({ status: 'Dispatched', item: itemName, quantity: targetQty });

    try {
        const db = getDB();
        bot.chat(`📦 Processing ${targetQty}x ${itemName}...`);

        // 1. Fetch Empty Shulker
        let shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        if (!shulkerStash) return bot.chat('❌ Error: No shulker boxes found!');

        const sVec = toVec(shulkerStash.pos);
        await bot.pathfinder.goto(new goals.GoalGetToBlock(sVec.x, sVec.y, sVec.z));
        const sContainer = await bot.openContainer(bot.blockAt(sVec));
        const sItem = sContainer.containerItems().find(i => i.name.includes('shulker_box'));
        await sContainer.withdraw(sItem.type, null, 1);
        sContainer.close();
        await wait(1000);

        // 2. Gather Items
        let gathered = 0;
        for (const stash of db) {
            if (gathered >= targetQty) break;
            const match = stash.items.find(i => i.name === itemName);
            if (match) {
                const itemVec = toVec(stash.pos);
                await bot.pathfinder.goto(new goals.GoalGetToBlock(itemVec.x, itemVec.y, itemVec.z));
                const c = await bot.openContainer(bot.blockAt(itemVec));
                const toTake = Math.min(targetQty - gathered, match.count);
                await c.withdraw(bot.registry.itemsByName[itemName].id, null, toTake);
                gathered += toTake;
                c.close();
                await wait(800);
            }
        }

        // 3. Packing (Safe Math Version)
        bot.pathfinder.setGoal(null);
        await wait(500);

        const bx = Math.floor(bot.entity.position.x) + 1;
        const by = Math.floor(bot.entity.position.y);
        const bz = Math.floor(bot.entity.position.z);
        const boxPos = new Vec3(bx, by, bz);
        const groundPos = new Vec3(bx, by - 1, bz);

        const shulkerInInv = bot.inventory.items().find(i => i.name.includes('shulker_box'));
        await bot.equip(shulkerInInv, 'hand');
        await wait(500);
        await bot.placeBlock(bot.blockAt(groundPos), new Vec3(0, 1, 0));
        await wait(1500);
        
        const box = await bot.openContainer(bot.blockAt(boxPos));
        const itemsToPack = bot.inventory.items().filter(i => i.name === itemName);
        for (const item of itemsToPack) {
            await box.deposit(item.type, null, item.count);
            await wait(200);
        }
        box.close();
        await wait(1000);
        await bot.dig(bot.blockAt(boxPos));
        await wait(1500);

        // 4. Delivery
        bot.chat(`🚚 Delivering to ${dest.x} ${dest.y} ${dest.z}`);
        await bot.pathfinder.goto(new goals.GoalNear(dest.x, dest.y, dest.z, 2));
        
        bot.pathfinder.setGoal(null);
        await wait(1500);
        const packed = bot.inventory.items().find(i => i.name.includes('shulker_box') && i.nbt);
        if (packed) await bot.tossStack(packed);
        bot.chat('✅ Delivered.');

    } catch (e) { 
        console.log(e);
        bot.chat('⚠️ Error: ' + e.message); 
    }
});

// --- DASHBOARD API ---
app.get('/stashes', (req, res) => {
    const db = getDB();
    const totals = {};
    db.forEach(s => s.items.forEach(i => {
        if(!i.name.includes('shulker_box')) totals[i.name] = (totals[i.name] || 0) + i.count;
    }));
    res.json(totals);
});

app.get('/', (req, res) => {
    res.send(`<html><head><style>
        body { background: #000; color: #0f0; font-family: monospace; padding: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
        .tile { border: 1px solid #0f0; padding: 10px; text-align: center; cursor: pointer; }
        .tile.selected { background: #0f0; color: #000; font-weight: bold; }
        .controls { margin-top: 20px; border-top: 1px solid #0f0; padding-top: 20px; }
        input { background: #000; border: 1px solid #0f0; color: #0f0; padding: 10px; margin-bottom: 10px; width: 100%; box-sizing: border-box; }
        button { background: #0f0; color: #000; border: none; padding: 20px; width: 100%; font-weight: bold; cursor: pointer; font-size: 1.2em; }
    </style></head><body>
        <h1>WAREHOUSE SYSTEM v5.0</h1>
        <div class="grid" id="items"></div>
        <div class="controls">
            QUANTITY: <input type="number" id="qty" value="64">
            COORDINATES (X Y Z): <input type="text" id="coords" placeholder="Example: 150 64 -200">
            <button onclick="send()">DISPATCH BOT</button>
        </div>
        <script>
            let sI=null;
            async function load() {
                const d = await(await fetch('/stashes')).json();
                document.getElementById('items').innerHTML = Object.entries(d).map(([n,c]) => 
                    \`<div class="tile \${sI==n?'selected':''}" onclick="sel('\${n}')">\${n.replace(/_/g,' ').toUpperCase()}<br>STOCK: \${c}</div>\`
                ).join('');
            }
            function sel(n){ sI=n; load(); }
            function send() {
                const q = document.getElementById('qty').value;
                const c = document.getElementById('coords').value.split(' ');
                if(!sI || c.length < 3) return alert("Select Item and Cords!");
                fetch('/order', { method:'POST', headers:{'Content-Type':'application/json'}, 
                body: JSON.stringify({itemName:sI, count:q, x:c[0], y:c[1], z:c[2]})});
                alert("Order Dispatched!");
            }
            setInterval(load, 5000); load();
        </script></body></html>`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Terminal Ready on ' + PORT));
createBot();
                    
