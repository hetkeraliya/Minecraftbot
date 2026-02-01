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
let botStatus = "System Hibernating"; 

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
        botStatus = "Active & Operational";
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        movements.canDig = true;
        movements.canPlaceOn = true;
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
                bot.chat('◈ Spawn Synchronized.');
            }
        }
        if (message === '!scan') {
            botStatus = "Scanning Catalog...";
            const containers = bot.findBlocks({ matching: b => ['chest', 'shulker_box', 'barrel', 'trapped_chest'].some(n => b.name.includes(n)), maxDistance: 64, count: 100 });
            let db = [];
            for (const pos of containers) {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
                const container = await bot.openContainer(bot.blockAt(pos));
                db.push({ pos, items: container.containerItems().map(i => ({ name: i.name, count: i.count })) });
                saveDB(db);
                container.close();
                await wait(200);
            }
            bot.chat('◈ Catalog Updated.');
            botStatus = "Active & Operational";
        }
    });

    bot.on('end', () => setTimeout(createBot, 10000));
}

// --- MISSION ENGINE ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, z } = req.body;
    let targetQty = Math.abs(parseInt(count)) || 64;
    res.json({ status: 'Order Dispatched' });

    try {
        let db = getDB();
        bot.chat(`◈ Order Received: ${targetQty}x ${itemName.replace(/_/g, ' ')}`);

        // 1. GATHERING LOOP
        let gathered = 0;
        while (gathered < targetQty) {
            botStatus = `Fetching Bulk: ${gathered}/${targetQty}`;
            
            // Get Shulker
            const shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
            await bot.pathfinder.goto(new goals.GoalGetToBlock(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z));
            const sCont = await bot.openContainer(bot.blockAt(shulkerStash.pos));
            await sCont.withdraw(sCont.containerItems().find(i => i.name.includes('shulker_box')).type, null, 1);
            sCont.close();

            // Fill Shulker capacity (27 slots)
            let loopGathered = 0;
            for (const stash of db) {
                if (loopGathered >= 1728 || gathered >= targetQty) break; // 1728 = full shulker
                const match = stash.items.find(i => i.name === itemName);
                if (match) {
                    await bot.pathfinder.goto(new goals.GoalGetToBlock(stash.pos.x, stash.pos.y, stash.pos.z));
                    const c = await bot.openContainer(bot.blockAt(stash.pos));
                    const item = c.containerItems().find(i => i.name === itemName);
                    if (item) {
                        const take = Math.min(targetQty - gathered, item.count, 1728 - loopGathered);
                        await c.withdraw(item.type, null, take);
                        gathered += take;
                        loopGathered += take;
                    }
                    c.close();
                }
            }

            // 2. PACKING
            botStatus = "Packing Assets...";
            const bx = Math.floor(bot.entity.position.x) + 1;
            const by = Math.floor(bot.entity.position.y);
            const bz = Math.floor(bot.entity.position.z);
            await bot.equip(bot.inventory.items().find(i => i.name.includes('shulker_box')), 'hand');
            await bot.placeBlock(bot.blockAt(new Vec3(bx, by - 1, bz)), new Vec3(0, 1, 0));
            await wait(1000);
            const packBox = await bot.openContainer(bot.blockAt(new Vec3(bx, by, bz)));
            for (const i of bot.inventory.items().filter(i => i.name === itemName)) await packBox.deposit(i.type, null, i.count);
            packBox.close();
            await wait(500);
            await bot.dig(bot.blockAt(new Vec3(bx, by, bz)));
            await wait(1000);
        }

        // 3. SMART XZ DELIVERY
        botStatus = "Navigating to Location...";
        const targetX = Number(x);
        const targetZ = Number(z);
        
        // Dynamic Y detection
        await bot.pathfinder.goto(new goals.GoalNear(targetX, 100, targetZ, 50)); // Get close first
        const y = bot.world.getHighestBlockAt(new Vec3(targetX, 0, targetZ))?.position.y || 64;
        await bot.pathfinder.goto(new goals.GoalGetToBlock(targetX, y + 1, targetZ));

        // 4. FIND NEARBY PLAYER
        botStatus = "Identifying Client...";
        const nearbyPlayer = bot.nearestEntity(e => e.type === 'player' && e.username !== bot.username);
        if (nearbyPlayer) {
            await bot.pathfinder.goto(new goals.GoalFollow(nearbyPlayer, 0));
        }

        bot.chat('◈ DELIVERY ARRIVED: Commencing Sacrifice.');
        await wait(1000);
        bot.chat('/kill');

        // 5. AUTO-DEDUCT
        let finalDB = getDB();
        let left = targetQty;
        finalDB = finalDB.map(s => {
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
        saveDB(finalDB);
        botStatus = "Ready at Warehouse";

    } catch (e) { botStatus = "System Fault"; }
});

// --- E-COMMERCE UI ---
app.get('/status', (req, res) => res.json({ status: botStatus }));
app.get('/stashes', (req, res) => {
    const db = getDB();
    const totals = {};
    db.forEach(s => s.items.forEach(i => { if(!i.name.includes('shulker_box')) totals[i.name] = (totals[i.name] || 0) + i.count; }));
    res.json(totals);
});
app.get('/players', (req, res) => {
    if (!bot || !bot.entities) return res.json([]);
    res.json(Object.values(bot.entities).filter(e => e.type === 'player' && e.username !== bot.username).map(p => ({ username: p.username, x: p.position.x, z: p.position.z })));
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        :root { --bg: #FDFCF8; --white: #FFFFFF; --cream: #F5F1E9; --text: #333333; --accent: #C5A059; }
        body { background: var(--bg); color: var(--text); font-family: 'Helvetica Neue', sans-serif; margin:0; padding: 20px; }
        .header { text-align: center; padding: 40px 0; border-bottom: 1px solid var(--cream); }
        .status-bar { background: var(--white); padding: 15px; border-radius: 10px; margin: 20px 0; font-size: 0.9em; box-shadow: 0 4px 10px rgba(0,0,0,0.02); }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; }
        .card { background: var(--white); padding: 25px; border-radius: 12px; border: 1px solid var(--cream); transition: 0.3s; cursor: pointer; text-align: center; }
        .card:hover { transform: translateY(-5px); border-color: var(--accent); }
        .card.selected { border: 2px solid var(--accent); background: var(--cream); }
        .section-title { font-size: 0.7em; letter-spacing: 2px; text-transform: uppercase; color: #AAA; margin: 40px 0 20px 0; }
        .player-chip { background: var(--white); border: 1px solid var(--cream); padding: 10px 20px; border-radius: 50px; display: inline-block; margin-right: 10px; cursor: pointer; }
        .player-chip.selected { background: var(--accent); color: white; }
        .footer { position: sticky; bottom: 20px; background: var(--white); padding: 25px; border-radius: 20px; box-shadow: 0 -10px 30px rgba(0,0,0,0.05); display: flex; gap: 15px; align-items: center; }
        input { border: 1px solid var(--cream); padding: 12px; border-radius: 8px; outline: none; flex: 1; }
        button { background: var(--accent); color: #FFF; border: none; padding: 15px 40px; border-radius: 8px; font-weight: bold; cursor: pointer; }
    </style></head><body>
        <div class="header"><h1>CUB LOGISTICS</h1><p>Minimalist Warehouse Automation</p></div>
        <div class="status-bar">● <span id="st">Synchronizing...</span></div>
        <div class="section-title">Store Catalog</div>
        <div class="grid" id="it"></div>
        <div class="section-title">Nearby Clients</div>
        <div id="pl"></div>
        <div class="footer">
            <input type="number" id="q" value="64" placeholder="Qty">
            <input type="text" id="c" placeholder="X Z (e.g. 100 -200)">
            <button onclick="dispatch()">PLACE ORDER</button>
        </div>
        <script>
            let si=null; let sp=null;
            async function refresh(){
                const items = await(await fetch('/stashes')).json();
                const status = await(await fetch('/status')).json();
                const players = await(await fetch('/players')).json();
                document.getElementById('st').innerText = status.status;
                document.getElementById('it').innerHTML = Object.entries(items).map(([n,c]) => \`
                    <div class="card \${si==n?'selected':''}" onclick="si='\${n}';refresh()">
                        <div style="font-size:0.8em; color:var(--accent);">IN STOCK</div>
                        <div style="font-weight:600; font-size:1.1em; margin:10px 0;">\${n.replace(/_/g,' ').toUpperCase()}</div>
                        <div style="color:#999;">\${c} Units</div>
                    </div>\`).join('');
                document.getElementById('pl').innerHTML = players.map(p => \`
                    <div class="player-chip \${sp?.u==p.username?'selected':''}" onclick="sp={u:'\${p.username}',x:\${p.x},z:\${p.z}};refresh()">👤 \${p.username}</div>\`).join('');
            }
            function dispatch(){
                const q = document.getElementById('q').value;
                const c = document.getElementById('c').value.split(' ');
                let p = sp ? {x:sp.x, z:sp.z} : {x:c[0], z:c[1]};
                fetch('/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemName:si,count:q,x:p.x,z:p.z,targetPlayer:sp?.u})});
                alert("Order Dispatched.");
            }
            setInterval(refresh, 2000); refresh();
        </script></body></html>`);
});

app.listen(10000);
createBot();
                
