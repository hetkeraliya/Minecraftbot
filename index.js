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
let botStatus = "System Idle"; 

const wait = (ms) => new Promise(res => setTimeout(res, ms));
const toVec = (pos) => new Vec3(Number(pos.x), Number(pos.y), Number(pos.z));

// --- INTELLIGENT SPACE FINDER ---
async function findValidSpace() {
    const offsets = [
        { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }
    ];
    for (const off of offsets) {
        const checkPos = bot.entity.position.offset(off.x, 0, off.z).floored();
        const ground = bot.blockAt(checkPos.offset(0, -1, 0));
        const air = bot.blockAt(checkPos);
        if (air && air.name === 'air' && ground && ground.name !== 'air') {
            return { box: checkPos, ground: ground };
        }
    }
    return null;
}

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
        movements.canDig = true;
        movements.canPlaceOn = true;
        bot.pathfinder.setMovements(movements);
    });

    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;

        if (message === '!setspawn') {
            bot.chat('◈ AI: Navigating to Bed...');
            const bed = bot.findBlock({ matching: b => bot.isABed(b), maxDistance: 32 });
            if (bed) {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z));
                await bot.activateBlock(bed);
                await wait(2000);
                bot.chat('◈ SUCCESS: Spawn Point Synchronized.');
            }
        }

        if (message === '!scan') {
            bot.chat('◈ AI: Commencing Warehouse Audit...');
            const containers = bot.findBlocks({ matching: b => ['chest', 'shulker_box', 'barrel', 'trapped_chest'].some(n => b.name.includes(n)), maxDistance: 64, count: 100 });
            let db = [];
            for (const pos of containers) {
                const target = toVec(pos);
                await bot.pathfinder.goto(new goals.GoalGetToBlock(target.x, target.y, target.z));
                const container = await bot.openContainer(bot.blockAt(target));
                db.push({ pos: {x: target.x, y: target.y, z: target.z}, items: container.containerItems().map(i => ({ name: i.name, count: i.count })) });
                saveDB(db);
                container.close();
                await wait(200);
            }
            bot.chat('◈ SUCCESS: Audit Complete. Catalog Updated.');
        }
    });

    bot.on('end', () => setTimeout(createBot, 10000));
}

// --- INTELLIGENT MISSION HANDLER ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, y, z, targetPlayer } = req.body;
    const targetQty = parseInt(count);
    res.json({ status: 'Processing' });

    try {
        bot.chat(`◈ MISSION: Delivering ${targetQty}x ${itemName}...`);
        let db = getDB();

        // 1. SHULKER PREP
        botStatus = "Equipping Shulker...";
        const shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        await bot.pathfinder.goto(new goals.GoalGetToBlock(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z));
        const sCont = await bot.openContainer(bot.blockAt(toVec(shulkerStash.pos)));
        await sCont.withdraw(sCont.containerItems().find(i => i.name.includes('shulker_box')).type, null, 1);
        sCont.close();

        // 2. MULTI-CHEST GATHERING
        botStatus = `Gathering ${targetQty} Units...`;
        let gathered = 0;
        for (const stash of db) {
            if (gathered >= targetQty) break;
            const match = stash.items.find(i => i.name === itemName);
            if (match) {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(stash.pos.x, stash.pos.y, stash.pos.z));
                const c = await bot.openContainer(bot.blockAt(toVec(stash.pos)));
                const found = c.containerItems().find(i => i.name === itemName);
                if (found) {
                    const take = Math.min(targetQty - gathered, found.count);
                    await c.withdraw(found.type, null, take);
                    gathered += take;
                }
                c.close();
            }
        }

        // 3. INTELLIGENT PACKING
        botStatus = "Packing Assets...";
        const space = await findValidSpace();
        await bot.pathfinder.goto(new goals.GoalNear(space.box.x, space.box.y, space.box.z, 2));
        
        const invShulker = bot.inventory.items().find(i => i.name.includes('shulker_box'));
        await bot.equip(invShulker, 'hand');
        await wait(500);
        await bot.placeBlock(bot.blockAt(space.ground.position), new Vec3(0, 1, 0));
        await wait(1000);

        const packBox = await bot.openContainer(bot.blockAt(space.box));
        for (const i of bot.inventory.items().filter(i => i.name === itemName)) await packBox.deposit(i.type, null, i.count);
        packBox.close();
        await wait(500);
        await bot.dig(bot.blockAt(space.box));
        await wait(1000);
        await bot.pathfinder.goto(new goals.GoalGetToBlock(space.box.x, space.box.y, space.box.z)); // Vacuum pick up

        // 4. DELIVERY & SACRIFICE
        botStatus = "Navigating to Location...";
        const dest = { x: Number(x), y: Number(y), z: Number(z) };
        if (targetPlayer) {
            const p = bot.players[targetPlayer]?.entity;
            await bot.pathfinder.goto(new goals.GoalFollow(p || bot.entity, 0));
        } else {
            await bot.pathfinder.goto(new goals.GoalNear(dest.x, dest.y, dest.z, 0));
        }

        bot.chat('◈ FINALIZING: Sacrifice initiated.');
        await wait(1000);
        bot.chat('/kill');

        // 5. DATABASE DEDUCTION
        let currentDB = getDB();
        let left = targetQty;
        currentDB = currentDB.map(s => {
            s.items = s.items.map(it => {
                if (it.name === itemName && left > 0) {
                    const take = Math.min(it.count, left);
                    it.count -= take;
                    left -= take;
                }
                return it;
            }).filter(it => it.count > 0);
            return s;
        });
        saveDB(currentDB);
        botStatus = "Ready at Warehouse";

    } catch (e) { botStatus = "System Error"; }
});

// --- API ---
app.get('/status', (req, res) => res.json({ status: botStatus }));
app.get('/stashes', (req, res) => {
    const db = getDB();
    const totals = {};
    db.forEach(s => s.items.forEach(i => { if(!i.name.includes('shulker_box')) totals[i.name] = (totals[i.name] || 0) + i.count; }));
    res.json(totals);
});
app.get('/players', (req, res) => {
    if (!bot || !bot.entities) return res.json([]);
    res.json(Object.values(bot.entities).filter(e => e.type === 'player' && e.username !== bot.username).map(p => ({ username: p.username, x: p.position.x, y: p.position.y, z: p.position.z })));
});

// --- WHITE E-COMMERCE UI ---
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        :root { --bg: #F9F7F2; --white: #FFFFFF; --cream: #F1ECE1; --text: #4A4A4A; --accent: #D4A373; }
        body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; }
        .header { text-align: center; margin-bottom: 40px; }
        .status-card { background: var(--white); border-radius: 15px; padding: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); margin-bottom: 20px; border-left: 5px solid var(--accent); }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 20px; }
        .card { background: var(--white); border-radius: 12px; padding: 15px; text-align: center; transition: 0.3s; cursor: pointer; border: 1px solid transparent; box-shadow: 0 2px 8px rgba(0,0,0,0.03); }
        .card:hover { border-color: var(--accent); transform: translateY(-5px); }
        .card.active { border-color: var(--accent); background: var(--cream); }
        .player-list { background: var(--white); border-radius: 12px; padding: 15px; margin-top: 20px; }
        .player-row { padding: 10px; margin: 5px 0; border-radius: 8px; background: var(--bg); cursor: pointer; border: 1px solid transparent; }
        .player-row.active { border-color: var(--accent); color: var(--accent); font-weight: bold; }
        .controls { position: sticky; bottom: 20px; background: var(--white); padding: 20px; border-radius: 15px; box-shadow: 0 -5px 20px rgba(0,0,0,0.05); margin-top: 40px; }
        input { padding: 12px; border-radius: 8px; border: 1px solid #DDD; margin-right: 10px; outline: none; background: var(--bg); }
        button { background: var(--accent); color: white; border: none; padding: 12px 30px; border-radius: 8px; font-weight: bold; cursor: pointer; }
    </style></head><body>
        <div class="header"><h1>CUB LOGISTICS</h1><p>Premium Warehouse Solutions</p></div>
        <div class="status-card"><b>AI STATUS:</b> <span id="st">Idle</span></div>
        <div class="grid" id="it"></div>
        <div class="player-list"><h3>NEARBY CLIENTS</h3><div id="pl"></div></div>
        <div class="controls">
            QTY: <input type="number" id="q" value="64">
            COR: <input type="text" id="c" placeholder="X Y Z">
            <button onclick="order()">DISPATCH DELIVERY</button>
        </div>
        <script>
            let si=null; let sp=null;
            async function sync(){
                const items = await(await fetch('/stashes')).json();
                const status = await(await fetch('/status')).json();
                const players = await(await fetch('/players')).json();
                document.getElementById('st').innerText = status.status;
                document.getElementById('it').innerHTML = Object.entries(items).map(([n,c]) => 
                    \`<div class="card \${si==n?'active':''}" onclick="si='\${n}';sync()">
                        <div style="font-size:0.8em; color:#999;">ITEM</div>
                        <div style="font-weight:bold; margin:10px 0;">\${n.replace(/_/g,' ').toUpperCase()}</div>
                        <div style="color:var(--accent);">STOCK: \${c}</div>
                    </div>\`).join('');
                document.getElementById('pl').innerHTML = players.map(p => 
                    \`<div class="player-row \${sp?.username==p.username?'active':''}" onclick="sp={username:'\${p.username}',x:\${p.x},y:\${p.y},z:\${p.z}};sync()">👤 \${p.username}</div>\`).join('');
            }
            function order(){
                const qty = document.getElementById('q').value;
                const cor = document.getElementById('c').value.split(' ');
                let pos = sp ? {x:sp.x,y:sp.y,z:sp.z} : {x:cor[0],y:cor[1],z:cor[2]};
                fetch('/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemName:si,count:qty,...pos,targetPlayer:sp?.username})});
                alert("Order Dispatched.");
            }
            setInterval(sync, 2000); sync();
        </script></body></html>`);
});

app.listen(10000);
createBot();
      
