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

const wait = (ms) => new Promise(res => setTimeout(res, ms));

// Force coordinates to be plain numbers to avoid "floor is not a function"
const toVec = (pos) => {
    return new Vec3(Number(pos.x), Number(pos.y), Number(pos.z));
};

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

    bot.on('error', (err) => console.log('📡 Network: ' + err.code));
    bot.on('spawn', () => {
        console.log('✅ Logistics System Online');
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        bot.pathfinder.setMovements(movements);
    });

    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;
        if (message === '!scan') {
            bot.chat('🔍 Scanning warehouse...');
            const containers = bot.findBlocks({
                matching: b => ['chest', 'shulker_box', 'barrel', 'trapped_chest'].some(n => b.name.includes(n)),
                maxDistance: 64, count: 50
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
                    await wait(400);
                } catch (e) { console.log('Scan skip:', e.message); }
            }
            bot.chat('✅ Scan Complete.');
        }
    });

    bot.on('end', () => setTimeout(createBot, 10000));
}

// --- REPAIRED ORDER LOGIC ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, y, z, targetPlayer } = req.body;
    res.json({ status: 'Dispatched' });

    try {
        const db = getDB();
        bot.chat('📦 Processing order...');

        // 1. Fetch Shulker
        let shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        if (!shulkerStash) return bot.chat('❌ No shulkers!');

        const sVec = toVec(shulkerStash.pos);
        await bot.pathfinder.goto(new goals.GoalGetToBlock(sVec.x, sVec.y, sVec.z));
        const sContainer = await bot.openContainer(bot.blockAt(sVec));
        const sItem = sContainer.containerItems().find(i => i.name.includes('shulker_box'));
        await sContainer.withdraw(sItem.type, null, 1);
        sContainer.close();
        await wait(1000);

        // 2. Gather Items
        let gathered = 0;
        const targetQty = Number(count) || 64;
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

        // 3. PACKING (Manual Math to fix "floor" error)
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
        for (const item of bot.inventory.items().filter(i => i.name === itemName)) {
            await box.deposit(item.type, null, item.count);
            await wait(200);
        }
        box.close();
        await wait(1000);
        await bot.dig(bot.blockAt(boxPos));
        await wait(1500);

        // 4. DELIVERY
        const dx = Number(x); const dy = Number(y); const dz = Number(z);
        if (targetPlayer && bot.players[targetPlayer]?.entity) {
            await bot.pathfinder.goto(new goals.GoalFollow(bot.players[targetPlayer].entity, 2));
        } else {
            await bot.pathfinder.goto(new goals.GoalNear(dx, dy, dz, 2));
        }
        
        bot.pathfinder.setGoal(null);
        await wait(1500);
        const packed = bot.inventory.items().find(i => i.name.includes('shulker_box') && i.nbt);
        if (packed) await bot.tossStack(packed);
        bot.chat('✅ Delivered.');

    } catch (e) { 
        console.log("Error:", e);
        bot.chat('⚠️ Error: ' + e.message); 
    }
});

// --- DASHBOARD API ---
app.get('/players', (req, res) => {
    if (!bot || !bot.entities) return res.json([]);
    const players = Object.values(bot.entities)
        .filter(e => e.type === 'player' && e.username !== bot.username)
        .map(p => ({ username: p.username, x: Math.floor(p.position.x), y: Math.floor(p.position.y), z: Math.floor(p.position.z) }));
    res.json(players);
});

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
        body { background: #000; color: #f00; font-family: monospace; padding: 20px; }
        .container { display: flex; gap: 20px; }
        .panel { border: 1px solid #f00; padding: 15px; flex: 1; height: 70vh; overflow-y: auto; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
        .tile { border: 1px solid #444; padding: 10px; text-align: center; cursor: pointer; }
        .tile.selected { border-color: #f00; background: #200; }
        .player-row { padding: 10px; border: 1px solid #333; margin-bottom: 5px; cursor: pointer; }
        .player-row.selected { background: #f00; color: #000; }
        button { background: #f00; color: #000; border: none; padding: 20px; width: 100%; font-weight: bold; margin-top: 20px; cursor: pointer; }
    </style></head><body>
        <h1>🛰️ LOGISTICS KING V3</h1>
        <div class="container">
            <div class="panel"><h3>WAREHOUSE</h3><div class="grid" id="items"></div></div>
            <div class="panel"><h3>PLAYERS</h3><div id="players"></div>
            <br>CUSTOM: <input id="custom" placeholder="X Y Z" style="width:100%"></div>
        </div>
        <button onclick="send()">DISPATCH</button>
        <script>
            let sI=null; let sP=null;
            async function load() {
                const items = await(await fetch('/stashes')).json();
                const players = await(await fetch('/players')).json();
                document.getElementById('items').innerHTML = Object.entries(items).map(([n,c]) => 
                    \`<div class="tile \${sI==n?'selected':''}" onclick="sItem('\${n}')">\${n.replace(/_/g,' ')}<br><b>\${c}</b></div>\`
                ).join('');
                document.getElementById('players').innerHTML = players.map(p => 
                    \`<div class="player-row \${sP?.username==p.username?'selected':''}" onclick="sPlayer('\${p.username}',\${p.x},\${p.y},\${p.z})">👤 \${p.username}</div>\`
                ).join('');
            }
            function sItem(n){ sI=n; load(); }
            function sPlayer(u,x,y,z){ sP={username:u,x,y,z}; load(); }
            function send() {
                let coords = sP ? {x:sP.x, y:sP.y, z:sP.z} : null;
                const cBox = document.getElementById('custom').value;
                if(cBox) { const c = cBox.split(' '); coords = {x:c[0], y:c[1], z:c[2]}; }
                fetch('/order', { method:'POST', headers:{'Content-Type':'application/json'}, 
                body: JSON.stringify({itemName:sI, count:64, ...coords, targetPlayer: sP?.username})});
                alert("Dispatched!");
            }
            setInterval(load, 3000); load();
        </script></body></html>`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Terminal Ready'));
createBot();
                                

