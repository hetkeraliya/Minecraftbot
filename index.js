const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');

// --- CONFIGURATION ---
const STASH_FILE = 'stashes.json';
const SETTINGS = {
    host: 'Bottest-wIQk.aternos.me:56433', // Use the numeric IP from your error log
    port: 56433,            // Use the port from your error log
    username: 'Cub_bot',
    version: '1.21.5',
    auth: 'offline',
    checkTimeoutInterval: 120000 
};


const app = express();
app.use(bodyParser.json());
let bot;

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
        console.log('✅ Logistics King Online');
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
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

// --- ORDER LOGIC WITH PACKING & AUTO-DEDUCTION ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, y, z } = req.body;
    const targetQty = parseInt(count) || 64;
    const dest = { x: Number(x), y: Number(y), z: Number(z) };

    res.json({ status: 'Dispatched' });

    try {
        const db = getDB();
        bot.chat(`📦 Task: ${targetQty}x ${itemName}`);

        // 1. GATHER SHULKER
        let shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        if (!shulkerStash) return bot.chat('❌ Error: No shulker boxes found!');
        
        await bot.pathfinder.goto(new goals.GoalGetToBlock(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z));
        const sContainer = await bot.openContainer(bot.blockAt(toVec(shulkerStash.pos)));
        const sItem = sContainer.containerItems().find(i => i.name.includes('shulker_box'));
        await sContainer.withdraw(sItem.type, null, 1);
        sContainer.close();
        await wait(1000);

        // 2. GATHER ITEMS
        let gathered = 0;
        for (const stash of db) {
            if (gathered >= targetQty) break;
            const itemMatch = stash.items.find(i => i.name === itemName);
            if (!itemMatch) continue;

            await bot.pathfinder.goto(new goals.GoalGetToBlock(stash.pos.x, stash.pos.y, stash.pos.z));
            const c = await bot.openContainer(bot.blockAt(toVec(stash.pos)));
            const available = c.containerItems().find(i => i.name === itemName);
            if (available) {
                const toTake = Math.min(targetQty - gathered, available.count);
                await c.withdraw(available.type, null, toTake);
                gathered += toTake;
            }
            c.close();
            await wait(800);
        }

        // 3. SECURE PACKING
        bot.pathfinder.setGoal(null);
        await wait(500);

        const bx = Math.floor(bot.entity.position.x) + 1;
        const by = Math.floor(bot.entity.position.y);
        const bz = Math.floor(bot.entity.position.z);
        const boxPos = new Vec3(bx, by, bz);
        const groundPos = new Vec3(bx, by - 1, bz);

        const shulkerInv = bot.inventory.items().find(i => i.name.includes('shulker_box'));
        await bot.equip(shulkerInv, 'hand');
        await wait(500);
        await bot.placeBlock(bot.blockAt(groundPos), new Vec3(0, 1, 0));
        await wait(1500);

        if (bot.blockAt(boxPos).name.includes('shulker_box')) {
            const box = await bot.openContainer(bot.blockAt(boxPos));
            const toPack = bot.inventory.items().filter(i => i.name === itemName);
            for (const item of toPack) {
                await box.deposit(item.type, null, item.count);
                await wait(200);
            }
            box.close();
            await wait(1000);
            await bot.dig(bot.blockAt(boxPos));
            await wait(1500);
        }

        // 4. DELIVERY & SMART DROP
        bot.chat(`🚚 Delivering to ${dest.x} ${dest.y} ${dest.z}`);
        await bot.pathfinder.goto(new goals.GoalNear(dest.x, dest.y, dest.z, 1));
        
        bot.pathfinder.setGoal(null);
        await wait(2000);
        
        // Final look down to drop at feet
        await bot.lookAt(new Vec3(dest.x, dest.y - 1, dest.z));

        const packed = bot.inventory.items().find(i => i.name.includes('shulker_box') && i.nbt);
        if (packed) {
            await bot.tossStack(packed);
            bot.chat('✅ Delivered: Shulker dropped.');
        } else {
            for (const i of bot.inventory.items().filter(i => i.name === itemName)) await bot.tossStack(i);
            bot.chat('📦 Delivered: Raw items dropped.');
        }

        // UPDATE DATABASE: Deduct after delivery
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

    } catch (e) { bot.chat('⚠️ Error: ' + e.message); }
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
    res.send(`<html><body style="background:#000;color:#0f0;font-family:monospace;padding:20px;">
        <h1>LOGISTICS TERMINAL v8.0</h1>
        <div id="items" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;"></div>
        <hr style="border-color:#0f0;margin:20px 0;">
        <div style="max-width:400px;">
            ORDER QTY: <input type="number" id="qty" value="64" style="width:100%;background:#000;color:#0f0;border:1px solid #0f0;padding:5px;"><br><br>
            COORDS (X Y Z): <input type="text" id="cor" placeholder="100 64 -200" style="width:100%;background:#000;color:#0f0;border:1px solid #0f0;padding:5px;"><br><br>
            <button onclick="send()" style="width:100%;background:#0f0;color:#000;padding:15px;font-weight:bold;cursor:pointer;">DISPATCH BOT</button>
        </div>
        <script>
            let sI=null;
            async function load() {
                const d = await(await fetch('/stashes')).json();
                document.getElementById('items').innerHTML = Object.entries(d).map(([n,c]) => 
                    \`<div onclick="sI='\${n}';load()" style="border:1px solid #0f0;padding:10px;text-align:center;cursor:pointer;background:\${sI==n?'#040':'none'}">
                        \${n.replace(/_/g,' ').toUpperCase()}<br><b>STOCK: \${c}</b>
                    </div>\`
                ).join('');
            }
            function send() {
                const q = document.getElementById('qty').value;
                const c = document.getElementById('cor').value.split(' ');
                if(!sI || c.length < 3) return alert("Select Item and enter X Y Z!");
                fetch('/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemName:sI,count:q,x:c[0],y:c[1],z:c[2]})});
                alert("Order Dispatched.");
            }
            setInterval(load, 5000); load();
        </script></body></html>`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Terminal Live'));
createBot();
                                           


