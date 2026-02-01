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
let botStatus = "Ready"; 

const wait = (ms) => new Promise(res => setTimeout(res, ms));
const toVec = (pos) => new Vec3(Number(pos.x), Number(pos.y), Number(pos.z));

// --- SMART PLACEMENT AI ---
async function findSmartSpace() {
    const searchRadius = 2;
    for (let x = -searchRadius; x <= searchRadius; x++) {
        for (let z = -searchRadius; z <= searchRadius; z++) {
            const checkPos = bot.entity.position.offset(x, 0, z).floored();
            const groundPos = checkPos.offset(0, -1, 0);
            
            const block = bot.blockAt(checkPos);
            const ground = bot.blockAt(groundPos);

            // Find air with solid ground beneath it
            if (block && block.name === 'air' && ground && ground.name !== 'air' && ground.name !== 'water') {
                return { boxPos: checkPos, groundBlock: ground };
            }
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

    // ... (Existing !scan and !setspawn logic)
    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;
        if (message === '!scan') {
            botStatus = "Scanning...";
            const containers = bot.findBlocks({ matching: b => ['chest', 'shulker_box', 'barrel'].some(n => b.name.includes(n)), maxDistance: 64, count: 50 });
            let db = [];
            for (const pos of containers) {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
                const container = await bot.openContainer(bot.blockAt(pos));
                db.push({ pos, items: container.containerItems().map(i => ({ name: i.name, count: i.count })) });
                saveDB(db);
                container.close();
            }
            botStatus = "Scan Done";
        }
    });

    bot.on('end', () => setTimeout(createBot, 10000));
}

app.post('/order', async (req, res) => {
    const { itemName, count, x, y, z, targetPlayer } = req.body;
    const targetQty = Math.abs(parseInt(count)) || 64;
    res.json({ status: 'Dispatched' });

    try {
        const db = getDB();
        
        // 1. GATHERING
        botStatus = "Gathering Shulker & Items...";
        const shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
        await bot.pathfinder.goto(new goals.GoalGetToBlock(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z));
        const sCont = await bot.openContainer(bot.blockAt(toVec(shulkerStash.pos)));
        await sCont.withdraw(sCont.containerItems().find(i => i.name.includes('shulker_box')).type, null, 1);
        sCont.close();

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

        // 2. THE SMART PACK (NEW AI)
        botStatus = "Finding Empty Space...";
        bot.pathfinder.setGoal(null);
        await wait(500);

        const space = await findSmartSpace();
        if (!space) {
            bot.chat("No space to place shulker! Standing in fire instead.");
            throw new Error("No Space");
        }

        // Move slightly away from the spot to have reach room
        await bot.pathfinder.goto(new goals.GoalNear(space.boxPos.x + 1, space.boxPos.y, space.boxPos.z + 1, 1));
        
        const shulkerInInv = bot.inventory.items().find(i => i.name.includes('shulker_box'));
        await bot.equip(shulkerInInv, 'hand');
        await wait(800);

        botStatus = "Placing Shulker...";
        await bot.placeBlock(space.groundBlock, new Vec3(0, 1, 0));
        await wait(1500);

        const packBox = await bot.openContainer(bot.blockAt(space.boxPos));
        for (const i of bot.inventory.items().filter(i => i.name === itemName)) {
            await packBox.deposit(i.type, null, i.count);
        }
        packBox.close();
        await wait(1000);

        botStatus = "Recovering Shulker...";
        await bot.dig(bot.blockAt(space.boxPos));
        await bot.pathfinder.goto(new goals.GoalGetToBlock(space.boxPos.x, space.boxPos.y, space.boxPos.z));
        await wait(1500);

        // 3. DELIVERY & KAMIKAZE
        if (targetPlayer) {
            const player = bot.players[targetPlayer]?.entity;
            await bot.pathfinder.goto(new goals.GoalFollow(player || bot.entity, 0));
        } else {
            await bot.pathfinder.goto(new goals.GoalNear(Number(x), Number(y), Number(z), 0));
        }
        
        botStatus = "Sacrifice Mode";
        await wait(1000);
        bot.chat('/kill');

    } catch (e) { botStatus = "AI Error: " + e.message; }
});

// --- API & UI ---
app.get('/status', (req, res) => res.json({ status: botStatus }));
app.get('/stashes', (req, res) => {
    const db = getDB();
    const totals = {};
    db.forEach(s => s.items.forEach(i => { if(!i.name.includes('shulker_box')) totals[i.name] = (totals[i.name] || 0) + i.count; }));
    res.json(totals);
});
app.get('/players', (req, res) => {
    if (!bot || !bot.entities) return res.json([]);
    const players = Object.values(bot.entities).filter(e => e.type === 'player' && e.username !== bot.username).map(p => ({ username: p.username, x: p.position.x, y: p.position.y, z: p.position.z }));
    res.json(players);
});
app.get('/', (req, res) => {
    res.send(`<html><body style="background:#000;color:#0f0;font-family:monospace;padding:20px;">
        <div style="border:2px solid #0f0;padding:15px;background:#111;">
            <h2>🤖 LOGISTICS AI</h2>
            <div id="status">Connecting...</div>
        </div>
        <div style="display:flex;gap:20px;margin-top:20px;">
            <div style="flex:1;"><h3>WAREHOUSE</h3><div id="items"></div></div>
            <div style="flex:1;"><h3>PLAYERS</h3><div id="players"></div></div>
        </div>
        <div style="margin-top:20px;border:1px solid #0f0;padding:15px;">
            QTY: <input type="number" id="qty" value="64">
            <button onclick="send()">DISPATCH MISSION</button>
        </div>
        <script>
            let sI=null; let sP=null;
            async function load() {
                const d = await(await fetch('/stashes')).json();
                const s = await(await fetch('/status')).json();
                const p = await(await fetch('/players')).json();
                document.getElementById('status').innerText = s.status;
                document.getElementById('items').innerHTML = Object.entries(d).map(([n,c]) => \`<div onclick="sI='\${n}';load()" style="border:1px solid #444;margin:5px;padding:5px;background:\${sI==n?'#040':'none'}">\${n} (\${c})</div>\`).join('');
                document.getElementById('players').innerHTML = p.map(player => \`<div onclick="sP={username:'\${player.username}',x:\${player.x},y:\${player.y},z:\${player.z}};load()" style="border:1px solid #444;margin:5px;padding:5px;background:\${sP?.username==player.username?'#040':'none'}">👤 \${player.username}</div>\`).join('');
            }
            function send() {
                const q = document.getElementById('qty').value;
                if(!sI) return alert("Select Item!");
                fetch('/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemName:sI,count:q,x:sP?.x||0,y:sP?.y||0,z:sP?.z||0,targetPlayer:sP?.username})});
            }
            setInterval(load, 2000); load();
        </script></body></html>`);
});

app.listen(10000);
createBot();
                      
