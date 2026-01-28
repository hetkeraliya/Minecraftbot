const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const express = require('express');

const SETTINGS = {
    host: 'play.applemc.fun', 
    port: 25565,              
    username: 'LogisticsKing_Pro',
    version: '1.21.5',
    auth: 'offline'
};

const MY_PASSWORD = 'Myhetkeraliya009'; // Set your password here
const app = express();
let bot;

function createBot() {
    bot = mineflayer.createBot(SETTINGS);
    bot.loadPlugin(pathfinder);

    // --- SMART AUTHENTICATION ---
    bot.on('messagestr', (message) => {
        console.log('Server:', message);

        // 1. Detect Register (First time join)
        if (message.includes('/register')) {
            console.log('📝 Registering new account...');
            bot.chat('/register ' + MY_PASSWORD + ' ' + MY_PASSWORD);
        }

        // 2. Detect Login (Returning join)
        if (message.includes('/login')) {
            console.log('🔓 Logging in...');
            bot.chat('/login ' + MY_PASSWORD);
        }
    });

    bot.on('spawn', () => {
        console.log('✅ Bot is in the server.');
        // Some servers require a tiny bit of movement to verify you aren't a ghost
        setTimeout(() => {
            bot.setControlState('jump', true);
            setTimeout(() => bot.setControlState('jump', false), 500);
        }, 3000);
    });

    bot.on('error', (err) => console.log('Bot Error:', err));
    bot.on('end', () => setTimeout(createBot, 10000));
}

const RENDER_PORT = process.env.PORT || 10000;
app.listen(RENDER_PORT, () => console.log('Dashboard active on port ' + RENDER_PORT));

createBot();
