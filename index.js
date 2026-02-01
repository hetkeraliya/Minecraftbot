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
    port: 56433,              
    username: 'Cub_bot',
    version: '1.21.5',
    auth: 'offline'
};

const app = express();
app.use(bodyParser.json());
let bot;
let botStatus = "Initializing..."; // Global status for the dashboard

const wait = (ms) => new Promise(res => setTimeout(res, ms));
const toVec = (pos) => new Vec3(Number(pos.x), Number(pos.y), Number(pos.z));

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

    bot.on('spawn', () => {
        botStatus = "Ready at Warehouse";
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        
        // --- UPGRADED AI SETTINGS ---
        movements.canDig = true;      // Break blocks in way
        movements.allowSprinting = true;
        movements.allowParkour = true; // Jump gaps
        movements.canPlaceOn = true;  // Bridge across water/void
        movements.liquidCost = 1;     // Optimized swimming
        
        bot.pathfinder.setMovements(movements);
    });

    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;

        if (message === '!setspawn') {
            botStatus = "Setting Spawn...";
            const bed = bot.findBlock({ matching: b => bot.isABed(b), maxDistance: 32 });
            if (bed) {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z));
                await bot.activateBlock(bed);
                await wait(2000);
                botStatus = "Spawn Point Locked";
            }
        }

        if (message === '!scan') {
            botStatus = "Scanning Warehouse...";
            const containers = bot.findBlocks({
                matching: b => ['chest', 'shulker_box', 'barrel', 'trapped_chest'].some(n => b.name.includes(n)),
                maxDistance: 64, count: 100
            });
            let db = [];
            for (const pos of containers) {
                const target = toVec(pos);
                await bot.pathfinder.goto(new goals.GoalGetToBlock(target.x, target.y, target.z));
                const container = await bot.openContainer(bot.blockAt(target));
                db.push({ pos: {x: target.x, y: target.y, z: target.z}, items: container.containerItems().map(i => ({ name: i.name, count: i.count })) });
                saveDB(db);
                container.close();
                await wait(300);
            }
            botStatus = "Scan Complete";
        }
    });

    bot.on('end', () => {
        botStatus = "Disconnected - Reconnecting...";
        setTimeout(createBot, 10000);
    });
}

// --- AI DRIVEN KAMIKAZE ORDER ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, y, z } = req.body;
    const targetQty = Math.abs(parseInt(count)) || 64;
    const dest = { x: Number(x), y: Number(y), z: Number(z) };
    res.json({ status: 'AI Mission Dispatched' });

    try {
        let db = getDB();
        
        // 1. GATHER SHULKER
        botStatus = "Locating Empty Shulker...";
        const shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        const sVec = toVec(shulkerStash.pos);
        await bot.pathfinder.goto(new goals.GoalGetToBlock(sVec.x, sVec.y, sVec.z));
        const sCont = await bot.openContainer(bot.blockAt(sVec));
        await sCont.withdraw(sCont.containerItems().find(i => i.name.includes('shulker_box')).type, null, 1);
        sCont.close();

        // 2. GATHER ITEMS
        botStatus = `Gathering ${itemName}...`;
        let gathered = 0;
        for (const stash of db) {
            if (gathered >= targetQty) break;
            const match = stash.items.find(i => i.name === itemName);
            if (match) {
                const itemVec = toVec(stash.pos);
                await bot.pathfinder.goto(new goals.GoalGetToBlock(itemVec.x, itemVec.y, itemVec.z));
                const c = await bot.openContainer(bot.blockAt(itemVec));
                const found = c.containerItems().find(i => i.name === itemName);
                if (found) {
                    const take = Math.min(targetQty - gathered, found.count);
                    await c.withdraw(found.type, null, take);
                    gathered += take;
                }
                c.close();
            }
        }

        // 3. PACKING
        botStatus = "Packing Shulker...";
        const bx = Math.floor(bot.entity.position.x) + 1;
        const by = Math.floor(bot.entity.position.y);
        const bz = Math.floor(bot.entity.position.z);
        const boxPos = new Vec3(bx, by, bz);
        const groundPos = new Vec3(bx, by - 1, bz);

        await bot.equip(bot.inventory.items().find(i => i.name.includes('shulker_box')), 'hand');
        await bot.placeBlock(bot.blockAt(groundPos), new Vec3(0, 1, 0));
        await wait(1500);
        const packBox = await bot.openContainer(bot.blockAt(boxPos));
        for (const i of bot.inventory.items().filter(i => i.name === itemName)) await packBox.deposit(i.type, null, i.count);
        packBox.close();
        await wait(500);
        await bot.dig(bot.blockAt(boxPos));

        // 4. ADVANCED TRAVEL
        botStatus = `AI Traveling to ${dest.x}, ${dest.z}...`;
        await bot.pathfinder.goto(new goals.GoalNear(dest.x, dest.y, dest.z, 0));
        
        botStatus = "Arrived. Executing Sacrifice.";
        await wait(1000);
        bot.chat('/kill');

        // 5. UPDATE DATABASE
        let finalDB = getDB();
        let deductLeft = targetQty;
        finalDB = finalDB.map(s => {
            s.items = s.items.map(it => {
                if (it.name === itemName && deductLeft > 0) {
                    const take = Math.min(it.count, deductLeft);
                    it.count -= take;
                    deductLeft -= take;
                }
                return it;
            }).filter(it => it.count > 0);
            return s;
        });
        saveDB(finalDB);
        botStatus = "Order Complete. Respawning.";

    } catch (e) { botStatus = "Error: " + e.message; }
});

// --- DASHBOARD WITH LIVE STATUS ---
app.get('/status', (req, res) => res.json({ status: botStatus }));

app.get('/stashes', (req, res) => {
    const db = getDB();
    const totals = {};
    db.forEach(s => s.items.forEach(i => {
        if(!i.name.includes('shulker_box')) totals[i.name] = (totals[i.name] || 0) + i.count;
    }));
    res.json(totals);
});

app.get('/', (req, res) => {
    res.send(`<html><body style="background:#000;color:#0f0;font-family:monospace;padding:20px;">
        <div style="border:2px solid #0f0;padding:15px;margin-bottom:20px;background:#111;">
            <h2 style="margin-top:0;">🤖 SYSTEM STATUS</h2>
            <div id="status" style="font-size:1.5em;color:#fff;text-shadow:0 0 10px #0f0;">Connecting...</div>
        </div>
        <div id="items" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;"></div>
        <div style="margin-top:20px;border-top:1px solid #0f0;padding-top:20px;">
            QTY: <input type="number" id="qty" value="64" style="background:#000;color:#0f0;border:1px solid #0f0;">
            COR: <input type="text" id="cor" placeholder="X Y Z" style="background:#000;color:#0f0;border:1px solid #0f0;">
            <button onclick="send()" style="background:#0f0;color:#000;padding:10px;font-weight:bold;cursor:pointer;">SACRIFICE BOT</button>
        </div>
        <script>
            let sI=null;
            async function load() {
                const d = await(await fetch('/stashes')).json();
                const s = await(await fetch('/status')).json();
                document.getElementById('status').innerText = s.status;
                document.getElementById('items').innerHTML = Object.entries(d).map(([n,c]) => 
                    \`<div onclick="sI='\${n}';load()" style="border:1px solid #0f0;padding:10px;text-align:center;cursor:pointer;background:\${sI==n?'#040':'none'}">
                        \${n.replace(/_/g,' ').toUpperCase()}<br><b>QTY: \${c}</b>
                    </div>\`
                ).join('');
            }
            function send() {
                const q = document.getElementById('qty').value;
                const c = document.getElementById('cor').value.split(' ');
                fetch('/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemName:sI,count:q,x:c[0],y:c[1],z:c[2]})});
            }
            setInterval(load, 2000); load();
        </script></body></html>`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Terminal Ready'));
createBot();
                                
