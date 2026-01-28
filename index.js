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
    auth: 'offline'
};

const app = express();
app.use(bodyParser.json());
let bot;

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
        console.log('✅ Logistics System Online');
        setTimeout(() => {
            const mcData = require('minecraft-data')(bot.version);
            const movements = new Movements(bot, mcData);
            movements.canDig = true;           
            movements.canPlaceOn = true;      
            bot.pathfinder.setMovements(movements);
        }, 2000);
    });

    // --- SCANNER COMMAND ---
    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;
        if (message === '!scan') {
            bot.chat('Scanning chests...');
            const containers = bot.findBlocks({
                matching: b => ['chest', 'shulker_box', 'barrel'].some(n => b.name.includes(n)),
                maxDistance: 32, count: 50
            });
            let db = [];
            for (const pos of containers) {
                try {
                    await bot.pathfinder.goto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
                    const container = await bot.openContainer(bot.blockAt(pos));
                    const items = container.containerItems().map(i => ({ name: i.name, count: i.count }));
                    db.push({ pos, items });
                    saveDB(db);
                    container.close();
                    await bot.waitForTicks(5);
                } catch (e) {}
            }
            bot.chat('Scan finished.');
        }
    });

    bot.on('end', () => setTimeout(createBot, 10000));
}

// --- API: FETCH NEARBY PLAYERS ---
app.get('/players', (req, res) => {
    if (!bot || !bot.entities) return res.json([]);
    const players = Object.values(bot.entities)
        .filter(e => e.type === 'player' && e.username !== bot.username)
        .map(p => ({
            username: p.username,
            x: Math.floor(p.position.x),
            y: Math.floor(p.position.y),
            z: Math.floor(p.position.z)
        }));
    res.json(players);
});

// --- API: LOGISTICS ORDER ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, y, z, targetPlayer } = req.body;
    res.json({ status: 'Dispatched' });
    const db = getDB();
    let gathered = 0;

    // 1. Get Shulker & Items (Standard Logic)
    let shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
    if (!shulkerStash) return bot.chat('No shulker found!');

    await bot.pathfinder.goto(new goals.GoalGetToBlock(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z));
    const sContainer = await bot.openContainer(bot.blockAt(shulkerStash.pos));
    const sItem = sContainer.containerItems().find(i => i.name.includes('shulker_box'));
    await sContainer.withdraw(sItem.type, null, 1);
    sContainer.close();

    // 2. Gather Items
    for (const stash of db) {
        if (gathered >= count) break;
        const match = stash.items.find(i => i.name === itemName);
        if (match) {
            await bot.pathfinder.goto(new goals.GoalGetToBlock(stash.pos.x, stash.pos.y, stash.pos.z));
            const container = await bot.openContainer(bot.blockAt(stash.pos));
            const toTake = Math.min(count - gathered, match.count);
            await container.withdraw(bot.registry.itemsByName[itemName].id, null, toTake);
            gathered += toTake;
            container.close();
        }
    }

    // 3. Pack Shulker
    bot.pathfinder.setGoal(null);
    const ground = bot.entity.position.offset(1, -1, 0).floored();
    const boxPos = bot.entity.position.offset(1, 0, 0).floored();
    const shulkerInInv = bot.inventory.items().find(i => i.name.includes('shulker_box'));
    await bot.equip(shulkerInInv, 'hand');
    await bot.placeBlock(bot.blockAt(ground), new Vec3(0, 1, 0));
    await bot.waitForTicks(20);
    const box = await bot.openContainer(bot.blockAt(boxPos));
    for (const item of bot.inventory.items().filter(i => i.name === itemName)) {
        await box.deposit(item.type, null, item.count);
    }
    box.close();
    await bot.waitForTicks(10);
    await bot.dig(bot.blockAt(boxPos));
    await bot.waitForTicks(20);

    // 4. SMART DELIVERY
    bot.chat(`Delivering to ${targetPlayer || 'coordinates'}...`);
    const deliverVec = new Vec3(parseInt(x), parseInt(y), parseInt(z));
    await bot.pathfinder.goto(new goals.GoalNear(deliverVec.x, deliverVec.y, deliverVec.z, 2));
    
    bot.pathfinder.setGoal(null);
    await bot.waitForTicks(20);
    const fullShulker = bot.inventory.items().find(i => i.name.includes('shulker_box') && i.nbt);
    if (fullShulker) await bot.tossStack(fullShulker);
    bot.chat('✅ Done.');
});

// --- TILED DASHBOARD WITH PLAYER SELECTOR ---
app.get('/', (req, res) => {
    res.send(`<html><head><style>
        body { background: #000; color: #f00; font-family: monospace; padding: 20px; }
        .container { display: flex; gap: 20px; }
        .panel { border: 1px solid #f00; padding: 15px; flex: 1; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
        .tile { border: 1px solid #444; padding: 10px; text-align: center; cursor: pointer; }
        .tile.selected { border-color: #f00; background: #200; }
        .player-row { padding: 10px; border: 1px solid #333; margin-bottom: 5px; cursor: pointer; }
        .player-row.selected { background: #f00; color: #000; }
        button { background: #f00; color: #000; border: none; padding: 15px; width: 100%; font-weight: bold; margin-top: 20px; }
    </style></head><body>
        <h1>WAREHOUSE COMMAND CENTER</h1>
        <div class="container">
            <div class="panel">
                <h3>1. SELECT ITEM</h3>
                <div class="grid" id="items"></div>
            </div>
            <div class="panel">
                <h3>2. SELECT TARGET PLAYER</h3>
                <div id="players"></div>
                <hr>
                OR CUSTOM: <input id="customCords" placeholder="X Y Z">
            </div>
        </div>
        <button onclick="sendOrder()">DISPATCH LOGISTICS BOT</button>

        <script>
            let selItem = null; let selPlayer = null;
            async function load() {
                const items = await(await fetch('/stashes')).json();
                const players = await(await fetch('/players')).json();
                
                document.getElementById('items').innerHTML = Object.entries(items).map(([n,c]) => 
                    \`<div class="tile" onclick="selI(this,'\${n}')">\${n.replace(/_/g,' ')}<br><b>\${c}</b></div>\`
                ).join('');

                document.getElementById('players').innerHTML = players.map(p => 
                    \`<div class="player-row" onclick="selP(this,'\${p.username}',\${p.x},\${p.y},\${p.z})">
                        👤 \${p.username} [\${p.x}, \${p.y}, \${p.z}]
                    </div>\`
                ).join('');
            }
            function selI(el, n) { 
                document.querySelectorAll('.tile').forEach(t=>t.classList.remove('selected'));
                el.classList.add('selected'); selItem = n; 
            }
            function selP(el, n, x, y, z) {
                document.querySelectorAll('.player-row').forEach(r=>r.classList.remove('selected'));
                el.classList.add('selected'); selPlayer = {n, x, y, z};
            }
            function sendOrder() {
                let coords = selPlayer ? {x:selPlayer.x, y:selPlayer.y, z:selPlayer.z} : null;
                if(document.getElementById('customCords').value) {
                    const c = document.getElementById('customCords').value.split(' ');
                    coords = {x:c[0], y:c[1], z:c[2]};
                }
                if(!selItem || !coords) return alert("Select Item AND Player/Coords!");
                fetch('/order', {
                    method:'POST',
                    headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({itemName:selItem, count:64, ...coords, targetPlayer: selPlayer?selPlayer.n:null})
                });
                alert("Bot Dispatched to " + (selPlayer?selPlayer.n : "coordinates"));
            }
            setInterval(load, 3000); load();
        </script></body></html>`);
});

app.get('/stashes', (req, res) => {
    const db = getDB();
    const totals = {};
    db.forEach(s => s.items.forEach(i => {
        if(!i.name.includes('shulker_box')) totals[i.name] = (totals[i.name] || 0) + i.count;
    }));
    res.json(totals);
});

const RENDER_PORT = process.env.PORT || 10000;
app.listen(RENDER_PORT, () => console.log('Dashboard active'));
createBot();
    


