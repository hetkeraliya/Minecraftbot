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

// --- DATABASE HANDLER ---
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

    bot.on('error', (err) => console.log('📡 Bot Error: ' + err.message));

    bot.on('spawn', () => {
        console.log('✅ Logistics King Online');
        setTimeout(() => {
            const mcData = require('minecraft-data')(bot.version);
            const movements = new Movements(bot, mcData);
            movements.canDig = true;           
            movements.canPlaceOn = true;      
            bot.pathfinder.setMovements(movements);
        }, 2000);
    });

    // --- COMMAND: !scan (Fills stashes.json) ---
    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;
        if (message === '!scan') {
            bot.chat('Scanning chests within 32 blocks...');
            const containers = bot.findBlocks({
                matching: b => ['chest', 'shulker_box', 'barrel', 'trapped_chest'].some(n => b.name.includes(n)),
                maxDistance: 32, count: 50
            });
            
            let db = [];
            for (const pos of containers) {
                try {
                    await bot.pathfinder.goto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
                    const block = bot.blockAt(pos);
                    const container = await bot.openContainer(block);
                    const items = container.containerItems().map(i => ({ name: i.name, count: i.count }));
                    db.push({ pos, items });
                    saveDB(db);
                    container.close();
                    await bot.waitForTicks(10);
                } catch (e) { console.log('Skipping blocked chest at ' + pos); }
            }
            bot.chat('Scan complete. Dashboard updated.');
        }
    });

    bot.on('end', () => setTimeout(createBot, 10000));
}

// --- LOGISTICS API: The Delivery Loop ---
app.post('/order', async (req, res) => {
    const { itemName, count, x, y, z } = req.body;
    res.json({ status: 'Processing' });
    const db = getDB();
    let gathered = 0;
    const targetCount = parseInt(count);

    // 1. GET EMPTY SHULKER
    let shulkerStash = db.find(s => s.items.some(i => i.name.includes('shulker_box')));
    if (!shulkerStash) return bot.chat('❌ Error: No shulker boxes found in any scanned chest!');

    const sPos = new Vec3(shulkerStash.pos.x, shulkerStash.pos.y, shulkerStash.pos.z);
    await bot.pathfinder.goto(new goals.GoalGetToBlock(sPos.x, sPos.y, sPos.z));
    const sContainer = await bot.openContainer(bot.blockAt(sPos));
    const shulkerItem = sContainer.containerItems().find(i => i.name.includes('shulker_box'));
    await sContainer.withdraw(shulkerItem.type, null, 1);
    sContainer.close();
    await bot.waitForTicks(20);

    // 2. GATHER ITEMS FROM CHESTS
    for (const stash of db) {
        if (gathered >= targetCount) break;
        const match = stash.items.find(i => i.name === itemName);
        if (match) {
            await bot.pathfinder.goto(new goals.GoalGetToBlock(stash.pos.x, stash.pos.y, stash.pos.z));
            const container = await bot.openContainer(bot.blockAt(new Vec3(stash.pos.x, stash.pos.y, stash.pos.z)));
            const toTake = Math.min(targetCount - gathered, match.count);
            await container.withdraw(bot.registry.itemsByName[itemName].id, null, toTake);
            gathered += toTake;
            container.close();
            await bot.waitForTicks(15);
        }
    }

    // 3. PACKING (Warehouse Phase)
    bot.pathfinder.setGoal(null); 
    const ground = bot.entity.position.offset(1, -1, 0).floored();
    const boxPos = bot.entity.position.offset(1, 0, 0).floored();
    
    // Clear spot
    if (bot.blockAt(boxPos).name !== 'air') await bot.dig(bot.blockAt(boxPos));

    const shulkerInInv = bot.inventory.items().find(i => i.name.includes('shulker_box'));
    await bot.equip(shulkerInInv, 'hand');
    await bot.placeBlock(bot.blockAt(ground), new Vec3(0, 1, 0));
    await bot.waitForTicks(30);

    const box = await bot.openContainer(bot.blockAt(boxPos));
    const itemsToPack = bot.inventory.items().filter(i => i.name === itemName);
    for (const item of itemsToPack) {
        await box.deposit(item.type, null, item.count);
        await bot.waitForTicks(5);
    }
    box.close();
    await bot.waitForTicks(20);
    await bot.dig(bot.blockAt(boxPos));
    await bot.waitForTicks(30);

    // 4. DELIVERY (Travel Phase)
    const deliverVec = new Vec3(parseInt(x), parseInt(y), parseInt(z));
    bot.chat('📦 Order packed. Delivering to ' + x + ' ' + y + ' ' + z);
    await bot.pathfinder.goto(new goals.GoalNear(deliverVec.x, deliverVec.y, deliverVec.z, 1));
    
    const fullShulker = bot.inventory.items().find(i => i.name.includes('shulker_box') && i.nbt);
    if (fullShulker) await bot.tossStack(fullShulker);
    bot.chat('✅ Delivery complete for ' + itemName);
});

// --- DASHBOARD UI ---
app.get('/stashes', (req, res) => {
    const db = getDB();
    const totals = {};
    db.forEach(s => s.items.forEach(i => {
        if(!i.name.includes('shulker_box')) totals[i.name] = (totals[i.name] || 0) + i.count;
    }));
    res.json(totals);
});

app.get('/', (req, res) => {
    res.send('<html><body style="background:#000;color:#ff0000;font-family:monospace;padding:20px;"><h1 style="text-align:center;">WAREHOUSE SYSTEM</h1><div id="grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:15px;"></div><script>async function load(){const d=await(await fetch("/stashes")).json();const g=document.getElementById("grid");g.innerHTML="";for(const[n,c]of Object.entries(d)){g.innerHTML+=\'<div style="border:1px solid #ff0000;padding:15px;text-align:center;"><b>\'+n.replace(/_/g," ").toUpperCase()+\'</b><p>STOCK: \'+c+\'</p><input type="number" id="qty-\'+n+\'" value="64" style="background:#111;color:#fff;border:1px solid #ff0000;width:60px;"><button onclick="order(\\\'\'+n+\'\\\')" style="background:#ff0000;color:#000;border:none;padding:10px;width:100%;margin-top:10px;font-weight:bold;cursor:pointer;">FETCH</button></div>\'}}function order(n){const q=document.getElementById("qty-"+n).value;const c=prompt("COORDS X Y Z:");if(!c)return;const p=c.split(" ");fetch("/order",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({itemName:n,count:q,x:p[0],y:p[1],z:p[2]})})}load();setInterval(load,5000);</script></body></html>');
});

const RENDER_PORT = process.env.PORT || 10000;
app.listen(RENDER_PORT, () => console.log('Dashboard active on port ' + RENDER_PORT));
createBot();
