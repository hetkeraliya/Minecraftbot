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
    checkTimeoutInterval: 120000 
};

const app = express();
app.use(bodyParser.json());
let bot;

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

    bot.on('error', (err) => console.log('📡 Network: ' + err.code));
    bot.on('kicked', (reason) => console.log('🚫 Kicked: ' + reason));

    bot.on('spawn', () => {
        console.log('✅ Logistics King Online');
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        movements.canDig = true;           
        movements.canPlaceOn = true;      
        bot.pathfinder.setMovements(movements);
    });

    // --- AGGRESSIVE SCANNER ---
    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;
        if (message === '!scan') {
            bot.chat('🔍 Scanning warehouse...');
            const containers = bot.findBlocks({
                matching: b => ['chest', 'shulker_box', 'barrel', 'trapped_chest'].some(n => b.name.includes(n)),
                maxDistance: 64, count: 100
            });

            if (containers.length === 0) return bot.chat('❌ No chests found!');
            
            let db = [];
            for (const pos of containers) {
                try {
                    await bot.pathfinder.goto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
                    await wait(800); // Higher delay for Aternos lag
                    const container = await bot.openContainer(bot.blockAt(pos));
                    const items = container.containerItems().map(i => ({ name: i.name, count: i.count }));
                    db.push({ pos, items });
                    saveDB(db);
                    container.close();
                    await wait(400);
                } catch (e) { console.log('Skipped: ' + pos); }
            }
            bot.chat('✅ Scan Complete.');
        }
    });

    bot.on('end', () => setTimeout(createBot, 10000));
}

// --- REFINED ORDER LOGIC ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, y, z, targetPlayer } = req.body;
    res.json({ status: 'Dispatched' });

    try {
        const db = getDB();
        bot.chat('📦 Processing ' + itemName + ' for ' + (targetPlayer || 'coords'));

        // 1. Fetch Shulker
        let shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        if (!shulkerStash) return bot.chat('❌ Error: No shulkers found!');

        await bot.pathfinder.goto(new goals.GoalGetToBlock(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z));
        const sContainer = await bot.openContainer(bot.blockAt(shulkerStash.pos));
        const sItem = sContainer.containerItems().find(i => i.name.includes('shulker_box'));
        await sContainer.withdraw(sItem.type, null, 1);
        sContainer.close();
        await wait(1500);

        // 2. Gather Items
        let gathered = 0;
        for (const stash of db) {
            if (gathered >= count) break;
            const match = stash.items.find(i => i.name === itemName);
            if (match) {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(stash.pos.x, stash.pos.y, stash.pos.z));
                const c = await bot.openContainer(bot.blockAt(stash.pos));
                const toTake = Math.min(count - gathered, match.count);
                await c.withdraw(bot.registry.itemsByName[itemName].id, null, toTake);
                gathered += toTake;
                c.close();
                await wait(800);
            }
        }

        // 3. Packing
        bot.pathfinder.setGoal(null);
        const ground = bot.entity.position.offset(1, -1, 0).floored();
        const boxPos = bot.entity.position.offset(1, 0, 0).floored();
        const shulkerInInv = bot.inventory.items().find(i => i.name.includes('shulker_box'));
        
        await bot.equip(shulkerInInv, 'hand');
        await bot.placeBlock(bot.blockAt(ground), new Vec3(0, 1, 0));
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

        // 4. SMART DELIVERY (Dynamic Goal)
        if (targetPlayer) {
            const player = bot.players[targetPlayer]?.entity;
            if (player) {
                await bot.pathfinder.goto(new goals.GoalFollow(player, 2));
            } else {
                await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
            }
        } else {
            await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
        }
        
        bot.pathfinder.setGoal(null);
        await wait(1500);
        const packed = bot.inventory.items().find(i => i.name.includes('shulker_box') && i.nbt);
        if (packed) await bot.tossStack(packed);
        bot.chat('✅ Delivered.');

    } catch (e) { bot.chat('⚠️ Error: ' + e.message); }
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
        .panel { border: 1px solid #f00; padding: 15px; flex: 1; height: 70vh; overflow-y: scroll; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
        .tile { border: 1px solid #444; padding: 10px; text-align: center; cursor: pointer; }
        .tile.selected { border-color: #f00; background: #200; }
        .player-row { padding: 10px; border: 1px solid #333; margin-bottom: 5px; cursor: pointer; }
        .player-row.selected { background: #f00; color: #000; }
        button { background: #f00; color: #000; border: none; padding: 20px; width: 100%; font-weight: bold; margin-top: 20px; cursor: pointer; }
    </style></head><body>
        <h1>🛰️ MASTER LOGISTICS KING</h1>
        <div class="container">
            <div class="panel"><h3>1. WAREHOUSE STOCK</h3><div class="grid" id="items"></div></div>
            <div class="panel"><h3>2. ACTIVE PLAYERS</h3><div id="players"></div>
            <br>MANUAL CORDS: <input id="custom" placeholder="X Y Z" style="width:100%"></div>
        </div>
        <button onclick="send()">DISPATCH LOGISTICS</button>
        <script>
            let selI=null; let selP=null;
            async function load() {
                const items = await(await fetch('/stashes')).json();
                const players = await(await fetch('/players')).json();
                document.getElementById('items').innerHTML = Object.entries(items).map(([n,c]) => 
                    \`<div class="tile \${selI==n?'selected':''}" onclick="selItem('\${n}')">\${n.replace(/_/g,' ').toUpperCase()}<br><b>\${c}</b></div>\`
                ).join('');
                document.getElementById('players').innerHTML = players.map(p => 
                    \`<div class="player-row \${selP?.username==p.username?'selected':''}" onclick="selPlayer('\${p.username}',\${p.x},\${p.y},\${p.z})">👤 \${p.username} [\${p.x}, \${p.y}, \${p.z}]</div>\`
                ).join('');
            }
            function selItem(n){ selI=n; load(); }
            function selPlayer(username,x,y,z){ selP={username,x,y,z}; load(); }
            function send() {
                let coords = selP ? {x:selP.x, y:selP.y, z:selP.z} : null;
                const custom = document.getElementById('custom').value;
                if(custom) { const c = custom.split(' '); coords = {x:c[0], y:c[1], z:c[2]}; }
                if(!selI || !coords) return alert("Select Item + Target!");
                fetch('/order', { method:'POST', headers:{'Content-Type':'application/json'}, 
                body: JSON.stringify({itemName:selI, count:64, ...coords, targetPlayer: selP?.username})});
                alert("Order Sent!");
            }
            setInterval(load, 3000); load();
        </script></body></html>`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Logistics Terminal Live'));
createBot();
