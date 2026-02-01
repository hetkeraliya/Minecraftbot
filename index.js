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
    version: '1.21.5', 
    auth: 'offline'
};

const app = express();
app.use(bodyParser.json());
let bot;
let botStatus = "System Idle"; 

const wait = (ms) => new Promise(res => setTimeout(res, ms));

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
        botStatus = "Active & Online";
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        movements.canDig = true;
        movements.allowSprinting = true;
        movements.allowParkour = true;
        bot.pathfinder.setMovements(movements);
    });

    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;
        if (message === '!setspawn') {
            const bed = bot.findBlock({ matching: b => bot.isABed(b), maxDistance: 32 });
            if (bed) {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z));
                await bot.activateBlock(bed);
                bot.chat('◈ AI: Spawn Point Synchronized.');
            }
        }
        if (message === '!scan') {
            botStatus = "Scanning Catalog...";
            const containers = bot.findBlocks({ matching: b => ['chest', 'shulker_box', 'barrel', 'trapped_chest'].some(n => b.name.includes(n)), maxDistance: 64, count: 100 });
            let db = [];
            for (const pos of containers) {
                try {
                    await bot.pathfinder.goto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
                    const container = await bot.openContainer(bot.blockAt(pos));
                    db.push({ pos, items: container.containerItems().map(i => ({ name: i.name, count: i.count })) });
                    saveDB(db);
                    container.close();
                    await wait(500);
                } catch (e) { console.log("Scan error at: " + pos); }
            }
            bot.chat('◈ AI: Warehouse Audit Complete.');
            botStatus = "Active & Online";
        }
    });

    bot.on('end', () => setTimeout(createBot, 10000));
}

// --- MISSION ENGINE (BULK + AUTO-Y) ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, z } = req.body;
    let targetQty = Math.abs(parseInt(count)) || 64;
    res.json({ status: 'Processing Dispatch' });

    try {
        let db = getDB();
        bot.chat(`◈ AI: Processing Order [${targetQty}x ${itemName}]`);

        // 1. GATHER SHULKER
        botStatus = "Fetching Shulker Box...";
        const shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        await bot.pathfinder.goto(new goals.GoalGetToBlock(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z));
        const sCont = await bot.openContainer(bot.blockAt(new Vec3(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z)));
        const shulkerItem = sCont.containerItems().find(i => i.name.includes('shulker_box'));
        await sCont.withdraw(shulkerItem.type, null, 1);
        sCont.close();
        await wait(1000);

        // 2. GATHER ITEMS (BULK LOGIC)
        botStatus = `Gathering ${targetQty} Items...`;
        let gathered = 0;
        for (const stash of db) {
            if (gathered >= targetQty) break;
            const match = stash.items.find(i => i.name === itemName);
            if (match) {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(stash.pos.x, stash.pos.y, stash.pos.z));
                const c = await bot.openContainer(bot.blockAt(new Vec3(stash.pos.x, stash.pos.y, stash.pos.z)));
                const item = c.containerItems().find(i => i.name === itemName);
                if (item) {
                    const take = Math.min(targetQty - gathered, item.count);
                    await c.withdraw(item.type, null, take);
                    gathered += take;
                }
                c.close();
                await wait(500);
            }
        }

        // 3. SMART PACKING
        botStatus = "Packing Assets...";
        const bx = Math.floor(bot.entity.position.x) + 1;
        const by = Math.floor(bot.entity.position.y);
        const bz = Math.floor(bot.entity.position.z);
        const boxPos = new Vec3(bx, by, bz);
        
        await bot.equip(bot.inventory.items().find(i => i.name.includes('shulker_box')), 'hand');
        await bot.placeBlock(bot.blockAt(new Vec3(bx, by - 1, bz)), new Vec3(0, 1, 0));
        await wait(1500);
        
        const packBox = await bot.openContainer(bot.blockAt(boxPos));
        for (const i of bot.inventory.items().filter(i => i.name === itemName)) {
            await packBox.deposit(i.type, null, i.count);
            await wait(200);
        }
        packBox.close();
        await wait(1000);
        await bot.dig(bot.blockAt(boxPos));
        await wait(2000); // Vacuum pickup time

        // 4. AUTO-Y DELIVERY
        botStatus = `Navigating to ${x}, ${z}...`;
        const tx = Number(x); const tz = Number(z);
        
        // Use high-altitude approach to find highest block safely
        await bot.pathfinder.goto(new goals.GoalNear(tx, 100, tz, 40)); 
        const ty = bot.world.getHighestBlockAt(new Vec3(tx, 0, tz))?.position.y || 64;
        await bot.pathfinder.goto(new goals.GoalGetToBlock(tx, ty + 1, tz));

        // Detect player within 10 blocks
        const target = bot.nearestEntity(e => e.type === 'player' && e.username !== bot.username);
        if (target) await bot.pathfinder.goto(new goals.GoalFollow(target, 0));

        bot.chat('◈ AI: Arrived at Destination. Sacrifice in 3s.');
        await wait(3000);
        bot.chat('/kill');

        // 5. UPDATE DB
        let currentDB = getDB();
        let rem = targetQty;
        currentDB = currentDB.map(s => {
            s.items = s.items.map(it => {
                if (it.name === itemName && rem > 0) {
                    const take = Math.min(it.count, rem);
                    it.count -= take;
                    rem -= take;
                }
                return it;
            }).filter(it => it.count > 0);
            return s;
        });
        saveDB(currentDB);

    } catch (e) { botStatus = "Ready at Warehouse"; bot.chat('◈ ERROR: Mission Aborted.'); }
});

// --- PORCELAIN WHITE UI ---
app.get('/status', (req, res) => res.json({ status: botStatus }));
app.get('/stashes', (req, res) => {
    const db = getDB();
    const totals = {};
    db.forEach(s => s.items.forEach(i => { if(!i.name.includes('shulker_box')) totals[i.name] = (totals[i.name] || 0) + i.count; }));
    res.json(totals);
});
app.get('/players', (req, res) => {
    if (!bot || !bot.entities) return res.json([]);
    res.json(Object.values(bot.entities).filter(e => e.type === 'player' && e.username !== bot.username).map(p => ({ u: p.username, x: Math.floor(p.position.x), z: Math.floor(p.position.z) })));
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        :root { --bg: #F8F9FA; --accent: #212529; --cream: #FFFFFF; --text: #343A40; --shadow: rgba(0,0,0,0.05); }
        body { background: var(--bg); color: var(--text); font-family: -apple-system, sans-serif; margin: 0; padding: 25px; }
        .nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; border-bottom: 1px solid #EEE; padding-bottom: 20px; }
        .status-pill { background: white; padding: 12px 25px; border-radius: 50px; font-size: 0.85em; box-shadow: 0 4px 10px var(--shadow); font-weight: 500; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 20px; }
        .card { background: var(--cream); padding: 25px; border-radius: 20px; box-shadow: 0 5px 15px var(--shadow); transition: 0.3s; cursor: pointer; text-align: center; border: 1px solid transparent; }
        .card:hover { transform: scale(1.02); border-color: #DDD; }
        .card.active { background: #F1F3F5; border-color: var(--accent); }
        .player-row { padding: 15px; background: white; border-radius: 12px; margin-bottom: 10px; cursor: pointer; display: flex; justify-content: space-between; box-shadow: 0 2px 8px var(--shadow); }
        .player-row.active { background: #343A40; color: white; }
        .checkout { position: sticky; bottom: 25px; background: white; padding: 25px; border-radius: 25px; box-shadow: 0 -10px 40px rgba(0,0,0,0.08); display: flex; gap: 15px; margin-top: 50px; }
        input { border: 1px solid #EEE; padding: 15px; border-radius: 12px; background: #F8F9FA; outline: none; flex: 1; }
        button { background: var(--accent); color: white; border: none; padding: 15px 45px; border-radius: 12px; font-weight: 600; cursor: pointer; transition: 0.2s; }
        button:hover { opacity: 0.9; }
    </style></head><body>
        <div class="nav"><h2>CUB LOGISTICS</h2> <div class="status-pill">● <span id="st">Idle</span></div></div>
        <div class="grid" id="it"></div>
        <h4 style="margin: 40px 0 15px 0; color: #888;">DETECTED CLIENTS</h4>
        <div id="pl"></div>
        <div class="checkout">
            <input type="number" id="q" value="64">
            <input type="text" id="c" placeholder="X Z (Manual)">
            <button onclick="order()">DISPATCH</button>
        </div>
        <script>
            let si=null; let sp=null;
            async function sync(){
                const items = await(await fetch('/stashes')).json();
                const status = await(await fetch('/status')).json();
                const players = await(await fetch('/players')).json();
                document.getElementById('st').innerText = status.status;
                document.getElementById('it').innerHTML = Object.entries(items).map(([n,c]) => \`
                    <div class="card \${si==n?'active':''}" onclick="si='\${n}';sync()">
                        <div style="font-size: 0.7em; color: #ADB5BD; text-transform: uppercase;">Stock</div>
                        <div style="font-weight: 700; margin: 12px 0; font-size: 1.1em;">\${n.replace(/_/g,' ').toUpperCase()}</div>
                        <div style="color: #495057;">\${c} Units</div>
                    </div>\`).join('');
                document.getElementById('pl').innerHTML = players.map(p => \`
                    <div class="player-row \${sp?.u==p.u?'active':''}" onclick="sp={u:'\${p.u}',x:\${p.x},z:\${p.z}};sync()">
                        <span>👤 \${p.u}</span> <span>X: \${p.x} Z: \${p.z}</span>
                    </div>\`).join('');
            }
            function order(){
                const q = document.getElementById('q').value;
                const c = document.getElementById('c').value.split(' ');
                let p = sp ? {x:sp.x, z:sp.z} : {x:c[0]||0, z:c[1]||0};
                fetch('/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemName:si,count:q,x:p.x,z:p.z})});
                alert("Order Dispatch Successful.");
            }
            setInterval(sync, 2000); sync();
        </script></body></html>`);
});

app.listen(10000);
createBot();
            
