const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');

// --- SETTINGS ---
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

async function findSafeSpace() {
    const radius = 2;
    for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
            const check = bot.entity.position.offset(x, 0, z).floored();
            const ground = bot.blockAt(check.offset(0, -1, 0));
            const air = bot.blockAt(check);
            if (air && air.name === 'air' && ground && ground.name !== 'air') return { box: check, ground: ground };
        }
    }
    return null;
}

function createBot() {
    if (bot) bot.removeAllListeners();
    bot = mineflayer.createBot(SETTINGS);
    bot.loadPlugin(pathfinder);

    bot.on('spawn', () => {
        botStatus = "Ready at Warehouse";
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        movements.canDig = true;
        movements.canPlaceOn = true;
        bot.pathfinder.setMovements(movements);
    });

    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;
        if (message === '!setspawn') {
            const bed = bot.findBlock({ matching: b => bot.isABed(b), maxDistance: 32 });
            if (bed) {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z));
                await bot.activateBlock(bed);
                bot.chat('◈ AI: Spawn Point Secured.');
            }
        }
        if (message === '!scan') {
            botStatus = "Scanning...";
            const containers = bot.findBlocks({ matching: b => ['chest', 'shulker_box', 'barrel'].some(n => b.name.includes(n)), maxDistance: 64, count: 100 });
            let db = [];
            for (const pos of containers) {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
                const container = await bot.openContainer(bot.blockAt(pos));
                db.push({ pos, items: container.containerItems().map(i => ({ name: i.name, count: i.count })) });
                saveDB(db);
                container.close();
                await wait(400);
            }
            bot.chat('◈ AI: Audit Complete.');
            botStatus = "Ready";
        }
    });

    bot.on('end', () => setTimeout(createBot, 10000));
}

// --- MISSION ENGINE (VANGUARD STATE MACHINE) ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, z } = req.body;
    let targetQty = Math.abs(parseInt(count)) || 64;
    res.json({ status: 'Initiating Mission' });

    try {
        let db = getDB();
        bot.chat(`◈ AI: Commencing delivery of ${targetQty}x ${itemName}...`);

        // STAGE 1: GATHER SHULKER
        botStatus = "S1: Packaging";
        const shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        await bot.pathfinder.goto(new goals.GoalGetToBlock(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z));
        const sCont = await bot.openContainer(bot.blockAt(new Vec3(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z)));
        await sCont.withdraw(sCont.containerItems().find(i => i.name.includes('shulker_box')).type, null, 1);
        sCont.close();
        await wait(600);

        // STAGE 2: GATHER ITEMS
        botStatus = "S2: Gathering";
        let gathered = 0;
        for (const stash of db) {
            if (gathered >= targetQty) break;
            const match = stash.items.find(i => i.name === itemName);
            if (match) {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(stash.pos.x, stash.pos.y, stash.pos.z));
                const c = await bot.openContainer(bot.blockAt(new Vec3(stash.pos.x, stash.pos.y, stash.pos.z)));
                const stacks = c.containerItems().filter(i => i.name === itemName);
                for (const stack of stacks) {
                    if (gathered >= targetQty) break;
                    const take = Math.min(targetQty - gathered, stack.count);
                    await c.withdraw(stack.type, null, take);
                    gathered += take;
                    await wait(300);
                }
                c.close();
                await wait(500);
            }
        }

        // STAGE 3: PACK & IRONCLAD VACUUM
        botStatus = "S3: Packing";
        const space = await findSafeSpace();
        await bot.equip(bot.inventory.items().find(i => i.name.includes('shulker_box')), 'hand');
        await bot.placeBlock(space.ground, new Vec3(0, 1, 0));
        await wait(1500);
        const packBox = await bot.openContainer(bot.blockAt(space.box));
        for (const i of bot.inventory.items().filter(i => i.name === itemName)) {
            await packBox.deposit(i.type, null, i.count);
            await wait(200);
        }
        packBox.close();
        await wait(1000);

        // THE VACUUM FIX (ENTITY RADAR)
        botStatus = "S4: Vacuuming";
        await bot.dig(bot.blockAt(space.box));
        
        let inventoryConfirmed = false;
        for (let i = 0; i < 15; i++) {
            const dropped = bot.nearestEntity(e => e.type === 'item');
            if (dropped) {
                await bot.pathfinder.goto(new goals.GoalFollow(dropped, 0));
            } else {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(space.box.x, space.box.y, space.box.z));
            }
            await wait(800);
            if (bot.inventory.items().some(item => item.name.includes('shulker_box') && item.nbt)) {
                inventoryConfirmed = true; 
                break; // BREAK LOOP IMMEDIATELY ON SUCCESS
            }
        }
        if (!inventoryConfirmed) throw new Error("Vacuum Timeout");

        // STAGE 5: NAVIGATION
        botStatus = "S5: En Route";
        const tx = Number(x); const tz = Number(z);
        await bot.pathfinder.goto(new goals.GoalNear(tx, 100, tz, 40)); 
        const ty = bot.world.getHighestBlockAt(new Vec3(tx, 0, tz))?.position.y || 64;
        await bot.pathfinder.goto(new goals.GoalGetToBlock(tx, ty + 1, tz));

        const player = bot.nearestEntity(e => e.type === 'player' && e.username !== bot.username);
        if (player) await bot.pathfinder.goto(new goals.GoalFollow(player, 0));

        botStatus = "S6: Sacrifice";
        bot.chat('◈ AI: Mission Complete.');
        await wait(1000);
        bot.chat('/kill');

        // STAGE 7: DATA SYNC
        let currentDB = getDB();
        let rem = targetQty;
        currentDB = currentDB.map(s => {
            s.items = s.items.map(it => {
                if (it.name === itemName && rem > 0) {
                    const take = Math.min(it.count, rem);
                    it.count -= take; rem -= take;
                }
                return it;
            }).filter(it => it.count > 0);
            return s;
        });
        saveDB(currentDB);
        botStatus = "Ready at Warehouse";

    } catch (e) { botStatus = "Ready"; bot.chat(`◈ AI ERROR: Mission Interrupted.`); }
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
        :root { --bg: #FDFCF8; --white: #FFFFFF; --cream: #F5F1E9; --accent: #D4A373; --text: #4A4A4A; }
        body { background: var(--bg); color: var(--text); font-family: -apple-system, sans-serif; margin: 0; padding: 25px; }
        .nav { display: flex; justify-content: space-between; align-items: center; padding: 20px 0; border-bottom: 1px solid var(--cream); margin-bottom: 40px; }
        .status-pill { background: var(--white); padding: 10px 20px; border-radius: 50px; font-size: 0.8em; font-weight: 700; color: var(--accent); box-shadow: 0 4px 15px rgba(0,0,0,0.04); }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 15px; }
        .card { background: var(--white); border-radius: 15px; padding: 30px 20px; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.02); cursor: pointer; border: 1px solid transparent; }
        .card.active { border-color: var(--accent); background: var(--cream); }
        .footer { position: sticky; bottom: 20px; background: var(--white); border-radius: 20px; padding: 20px; display: flex; gap: 10px; box-shadow: 0 -10px 30px rgba(0,0,0,0.05); margin-top: 40px; }
        input { flex: 1; border: 1px solid var(--cream); padding: 12px; border-radius: 10px; background: var(--bg); outline: none; font-weight: 600; }
        button { background: var(--accent); color: white; border: none; padding: 12px 35px; border-radius: 10px; font-weight: 800; cursor: pointer; }
    </style></head><body>
        <div class="nav"><h2>CUB LOGISTICS</h2> <div class="status-pill">● <span id="st">Ready</span></div></div>
        <div class="grid" id="it"></div>
        <div id="pl" style="margin-top: 30px;"></div>
        <div class="footer">
            <input type="number" id="q" value="64">
            <input type="text" id="c" placeholder="X Z">
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
                        <div style="font-weight: 700; font-size: 1.1em; margin: 10px 0;">\${n.replace(/_/g,' ').toUpperCase()}</div>
                        <div style="color: #999; font-size: 0.85em;">\${c} Units</div>
                    </div>\`).join('');
                document.getElementById('pl').innerHTML = players.map(p => \`
                    <div onclick="sp={u:'\${p.u}',x:\${p.x},z:\${p.z}}" style="padding:15px; background:white; margin-bottom:10px; border-radius:12px; cursor:pointer; display:flex; justify-content:space-between; box-shadow:0 4px 10px rgba(0,0,0,0.02);">
                        <span>👤 \${p.u}</span> <span>\${p.x} / \${p.z}</span>
                    </div>\`).join('');
            }
            function order(){
                const q = document.getElementById('q').value;
                const c = document.getElementById('c').value.split(' ');
                let p = sp ? {x:sp.x, z:sp.z} : {x:c[0]||0, z:c[1]||0};
                fetch('/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemName:si,count:q,x:p.x,z:p.z})});
            }
            setInterval(sync, 2000); sync();
        </script></body></html>`);
});

app.listen(10000);
createBot();
            
