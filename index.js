const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3'); 
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');

const STASH_FILE = 'stashes.json';
const SETTINGS = {
    host: 'YOUR_ATERNOS_IP.aternos.me', // <--- Put your Aternos IP here
    port: 25565,                         // <--- Aternos default is usually 25565
    username: 'LogisticsKing',
    version: '1.21.5',
    auth: 'offline',
    checkTimeoutInterval: 90000 
};

const app = express();
app.use(bodyParser.json());
let bot;

// --- Database Helper ---
const getDB = () => {
    try {
        if (!fs.existsSync(STASH_FILE)) return [];
        const data = fs.readFileSync(STASH_FILE, 'utf8');
        return data.trim() ? JSON.parse(data) : [];
    } catch (e) { return []; }
};
const saveDB = (data) => fs.writeFileSync(STASH_FILE, JSON.stringify(data, null, 2));

function createBot() {
    bot = mineflayer.createBot(SETTINGS);
    bot.loadPlugin(pathfinder);

    bot.on('login', () => console.log("📡 Connected to Aternos!"));
    
    bot.on('spawn', () => {
        console.log("✅ Logistics King Spawned");
        setTimeout(() => {
            const mcData = require('minecraft-data')(bot.version);
            const movements = new Movements(bot, mcData);
            movements.canDig = true;           
            movements.canPlaceOn = true;      
            bot.pathfinder.setMovements(movements);
        }, 2000);
    });

    // --- AUTOMATED WAREHOUSE LOGIC ---
    app.post('/order', async (req, res) => {
        const { itemName, count, x, y, z } = req.body;
        res.json({ status: "Dispatched" });
        const db = getDB();
        let gathered = 0;
        const targetCount = parseInt(count);

        // 1. Find Shulker in Chests
        let shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        if (!shulkerStash) return bot.chat("Error: No shulker boxes in stashes!");

        const sPos = new Vec3(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z);
        await bot.pathfinder.goto(new goals.GoalGetToBlock(sPos.x, sPos.y, sPos.z));
        const sContainer = await bot.openContainer(bot.blockAt(sPos));
        const shulkerItem = sContainer.containerItems().find(i => i.name.includes('shulker_box'));
        await sContainer.withdraw(shulkerItem.type, null, 1);
        sContainer.close();
        await bot.waitForTicks(20);

        // 2. Gather Items
        for (const stash of db) {
            if (gathered >= targetCount) break;
            const match = stash.items.find(i => i.name === itemName);
            if (match) {
                const p = new Vec3(stash.pos.x, stash.pos.y, stash.pos.z);
                await bot.pathfinder.goto(new goals.GoalGetToBlock(p.x, p.y, p.z));
                const container = await bot.openContainer(bot.blockAt(p));
                const toTake = Math.min(targetCount - gathered, match.count);
                await container.withdraw(bot.registry.itemsByName[itemName].id, null, toTake);
                gathered += toTake;
                container.close();
                await bot.waitForTicks(15);
            }
        }

        // 3. Warehouse Packing
        bot.pathfinder.setGoal(null); 
        const ground = bot.entity.position.offset(1, -1, 0).floored();
        const boxPos = bot.entity.position.offset(1, 0, 0).floored();

        const blockInWay = bot.blockAt(boxPos);
        if (blockInWay && blockInWay.name !== 'air') await bot.dig(blockInWay);

        const shulkerInInv = bot.inventory.items().find(i => i.name.includes('shulker_box'));
        await bot.equip(shulkerInInv, 'hand');
        await bot.placeBlock(bot.blockAt(ground), new Vec3(0, 1, 0));
        await bot.waitForTicks(30);

        const box = await bot.openContainer(bot.blockAt(boxPos));
        const itemsToPack = bot.inventory.items().filter(i => i.name === itemName);
        for (const item of itemsToPack) {
            await box.deposit(item.type, null, item.count);
            await bot.waitForTicks(5);
        }
        box.close();
        await bot.waitForTicks(20);
        await bot.dig(bot.blockAt(boxPos));
        await bot.waitForTicks(30);

        // 4. Delivery
        const deliverVec = new Vec3(parseInt(x), parseInt(y), parseInt(z));
        await bot.pathfinder.goto(new goals.GoalNear(deliverVec.x, deliverVec.y, deliverVec.z, 2));
        
        const fullShulker = bot.inventory.items().find(i => i.name.includes('shulker_box') && i.nbt);
        if (fullShulker) await bot.tossStack(fullShulker);
        bot.chat(`Delivered ${gathered}x \${itemName}`);
    });

    bot.on('error', (err) => console.log("Bot Error:", err));
    bot.on('end', () => {
        console.log("Disconnected. Reconnecting in 10s...");
        setTimeout(createBot, 10000);
    });
}

// --- RED/BLACK TILED UI ---
app.get('/stashes', (req, res) => {
    const db = getDB();
    const totals = {};
    db.forEach(s => s.items.forEach(i => {
        if(!i.name.includes('shulker_box')) totals[i.name] = (totals[i.name] || 0) + i.count;
    }));
    res.json(totals);
});

app.get('/', (req, res) => {
    res.send(`
    <html>
    <head>
        <style>
            body { background: #000; color: #ff0000; font-family: monospace; padding: 20px; }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
            .tile { border: 1px solid #ff0000; padding: 15px; text-align: center; border-radius: 5px; }
            input { background: #111; border: 1px solid #ff0000; color: #fff; width: 60px; margin-bottom: 5px; }
            button { background: #ff0000; color: #000; border: none; padding: 5px; cursor: pointer; width: 100%; font-weight: bold; }
        </style>
    </head>
    <body>
        <h1 style="text-align:center;">WAREHOUSE COMMAND</h1>
        <div class="grid" id="grid"></div>
        <script>
            async function load() {
                const data = await (await fetch('/stashes')).json();
                const grid = document.getElementById('grid');
                grid.innerHTML = '';
                for (const [name, count] of Object.entries(data)) {
                    grid.innerHTML += \`<div class="tile">
                        <b>\${name.replace(/_/g, ' ')}</b>
                        <p>STK: \${count}</p>
                        <input type="number" id="qty-\${name}" value="64">
                        <button onclick="order('\${name}')">FETCH</button>
                    </div>\`;
                }
            }
            function order(name) {
                const qty = document.getElementById('qty-'+name).value;
                const coords = prompt("COORDS X Y Z:");
                if (!coords) return;
                const p = coords.split(' ');
                fetch('/order', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({itemName: name, count: qty, x: p[0], y: p[1], z: p[2]})
                });
            }
            load();
            setInterval(load, 10000);
        </script>
    </body>
    </html>`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(\`Dashboard running on port \${PORT}\`));
createBot();
                                                                   
