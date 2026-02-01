const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');

const STASH_FILE = 'stashes.json';
const SETTINGS = {
    host: 'Bottest-wIQk.aternos.me', 
    port: 56433,              
    username: 'Cub_bot',
    version: '1.21.1',
    auth: 'offline'
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
        console.log('✅ Cub_bot Online');
        const mcData = require('minecraft-data')(bot.version);
        bot.pathfinder.setMovements(new Movements(bot, mcData));
    });

    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;

        // 🛏️ FIXED BED SPAWN LOGIC
        if (message === '!setspawn') {
            bot.chat('Locating bed for spawn point...');
            const bed = bot.findBlock({
                matching: b => bot.isABed(b),
                maxDistance: 32
            });
            if (bed) {
                try {
                    await bot.pathfinder.goto(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z));
                    await bot.activateBlock(bed); // Right-click bed
                    await wait(2000);
                    bot.chat('Spawn point set at bed. Standing by.');
                } catch (e) { bot.chat('Failed to reach bed!'); }
            } else {
                bot.chat('No bed found nearby!');
            }
        }

        // 🔍 AGGRESSIVE SCAN
        if (message === '!scan') {
            bot.chat('🔍 Scanning warehouse...');
            const containers = bot.findBlocks({
                matching: b => ['chest', 'shulker_box', 'barrel', 'trapped_chest'].some(n => b.name.includes(n)),
                maxDistance: 64, count: 100
            });
            let db = [];
            for (const pos of containers) {
                try {
                    const target = toVec(pos);
                    await bot.pathfinder.goto(new goals.GoalGetToBlock(target.x, target.y, target.z));
                    await wait(800);
                    const container = await bot.openContainer(bot.blockAt(target));
                    db.push({ pos: {x: target.x, y: target.y, z: target.z}, items: container.containerItems().map(i => ({ name: i.name, count: i.count })) });
                    saveDB(db);
                    container.close();
                    await wait(300);
                } catch (e) {}
            }
            bot.chat('✅ Scan Complete.');
        }
    });

    bot.on('end', () => setTimeout(createBot, 10000));
}

// --- SECURE ORDER & KAMIKAZE ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, y, z } = req.body;
    const targetQty = Math.abs(parseInt(count)) || 64;
    const dest = { x: Number(x), y: Number(y), z: Number(z) };
    res.json({ status: 'Sacrifice Dispatched' });

    try {
        let db = getDB();
        bot.chat(`📦 Mission: ${targetQty}x ${itemName}`);

        // 1. GATHER SHULKER (Strict Check)
        const shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        if (!shulkerStash) return bot.chat('❌ No Shulker found in Database!');

        const sVec = toVec(shulkerStash.pos);
        await bot.pathfinder.goto(new goals.GoalGetToBlock(sVec.x, sVec.y, sVec.z));
        const sCont = await bot.openContainer(bot.blockAt(sVec));
        const sItem = sCont.containerItems().find(i => i.name.includes('shulker_box'));
        await sCont.withdraw(sItem.type, null, 1);
        sCont.close();
        await wait(1000);

        // 2. GATHER ITEMS
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
                await wait(800);
            }
        }

        // 3. PACKING (Bulletproof Math)
        bot.pathfinder.setGoal(null);
        const bx = Math.floor(bot.entity.position.x) + 1;
        const by = Math.floor(bot.entity.position.y);
        const bz = Math.floor(bot.entity.position.z);
        const boxPos = new Vec3(bx, by, bz);
        const groundPos = new Vec3(bx, by - 1, bz);

        const invShulker = bot.inventory.items().find(i => i.name.includes('shulker_box'));
        await bot.equip(invShulker, 'hand');
        await wait(1000);
        await bot.placeBlock(bot.blockAt(groundPos), new Vec3(0, 1, 0));
        await wait(1500);

        const packBox = await bot.openContainer(bot.blockAt(boxPos));
        for (const i of bot.inventory.items().filter(i => i.name === itemName)) {
            await packBox.deposit(i.type, null, i.count);
        }
        packBox.close();
        await wait(1000);
        await bot.dig(bot.blockAt(boxPos));
        await wait(1500);

        // 4. THE SACRIFICE
        bot.chat(`🚚 Sacrifice arriving at ${dest.x} ${dest.y} ${dest.z}`);
        await bot.pathfinder.goto(new goals.GoalNear(dest.x, dest.y, dest.z, 0));
        await wait(2000);
        
        bot.chat('💀 Dropping items via suicide...');
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

    } catch (e) { bot.chat('⚠️ Error: ' + e.message); }
});

// --- DASHBOARD ---
app.get('/stashes', (req, res) => {
    const db = getDB();
    const totals = {};
    db.forEach(s => s.items.forEach(i => {
        if(!i.name.includes('shulker_box')) totals[i.name] = (totals[i.name] || 0) + i.count;
    }));
    res.json(totals);
});

app.get('/', (req, res) => {
    res.send(`<html><body style="background:#000;color:#f00;font-family:monospace;padding:20px;">
        <h1>KAMIKAZE LOGISTICS FINAL</h1>
        <div id="items" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;"></div>
        <div style="margin-top:20px;border-top:1px solid #f00;padding-top:20px;">
            QTY: <input type="number" id="qty" value="64">
            COR: <input type="text" id="cor" placeholder="X Y Z">
            <button onclick="send()" style="background:#f00;color:#000;padding:10px;font-weight:bold;cursor:pointer;">SACRIFICE BOT</button>
        </div>
        <script>
            let sI=null;
            async function load() {
                const d = await(await fetch('/stashes')).json();
                document.getElementById('items').innerHTML = Object.entries(d).map(([n,c]) => 
                    \`<div onclick="sI='\${n}';load()" style="border:1px solid #f00;padding:10px;text-align:center;cursor:pointer;background:\${sI==n?'#400':'none'}">
                        \${n.replace(/_/g,' ').toUpperCase()}<br><b>QTY: \${c}</b>
                    </div>\`
                ).join('');
            }
            function send() {
                const q = document.getElementById('qty').value;
                const c = document.getElementById('cor').value.split(' ');
                fetch('/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemName:sI,count:q,x:c[0],y:c[1],z:c[2]})});
                alert("Initiated.");
            }
            setInterval(load, 5000); load();
        </script></body></html>`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Terminal Ready'));
createBot();
