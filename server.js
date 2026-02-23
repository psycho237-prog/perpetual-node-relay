const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");
const P = require("pino");
const { Boom } = require("@hapi/boom");
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const app = express();
const port = process.env.PORT || 8080;

let currentQr = null;
let isConnected = false;
let socket = null;
let pollInterval = null;

// Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('[CRASH] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRASH] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Express Server
app.get('/', async (req, res) => {
    if (isConnected) return res.send('<h1>Bot Active</h1>');
    if (currentQr) {
        const qrDataUri = await QRCode.toDataURL(currentQr);
        return res.send(`<html><body style="background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;"><img src="${qrDataUri}" /></body></html>`);
    }
    res.send('<h1>Initializing...</h1>');
});

app.listen(port, () => console.log(`[${new Date().toISOString()}] Server on ${port}`));

function githubRequest(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
        if (!process.env.GH_TOKEN) return reject(new Error('GH_TOKEN missing'));
        const options = {
            hostname: 'api.github.com',
            path: urlPath,
            method: method,
            headers: {
                'Authorization': `Bearer ${process.env.GH_TOKEN}`,
                'User-Agent': 'WA-Bot',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (d) => data += d);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(data ? JSON.parse(data) : null);
                else reject(new Error(`GH API ${res.statusCode}: ${data}`));
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    socket = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
        },
        logger: P({ level: 'silent' })
    });

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQr = qr;
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            isConnected = false;
            const code = lastDisconnect.error?.output?.statusCode;
            console.log(`Connection closed (${code}). Reconnecting...`);
            if (code !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('Bot Connected!');
            isConnected = true;
            currentQr = null;

            // Startup Notification
            const ownerId = state.creds.me.id.split(':')[0] + '@s.whatsapp.net';
            await socket.sendMessage(ownerId, { text: '🚀 *WhatsApp Bot Online*\n\nYour 24/7 relay is now active and monitoring notifications.' });
        }
    });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        console.log(`[MSG] ${jid}: ${text}`);
        if (text === '.ping') await socket.sendMessage(jid, { text: 'pong! 🏓' });
        if (text === '.menu') await socket.sendMessage(jid, { text: '*Commands:*\n.ping\n.menu' });
    });

    // Singleton Poller
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
        if (!isConnected || !socket) return;
        try {
            const repo = process.env.GITHUB_REPOSITORY || "psycho237-prog/perpetual-node-relay";
            const files = await githubRequest('GET', `/repos/${repo}/contents/notifications`);
            if (!files || !Array.isArray(files)) return;

            for (const file of files) {
                if (!file.name.endsWith('.json')) continue;
                const fileData = await githubRequest('GET', `/repos/${repo}/contents/${file.path}`);
                const data = JSON.parse(Buffer.from(fileData.content, 'base64').toString());
                const ownerId = state.creds.me.id.split(':')[0] + '@s.whatsapp.net';

                await socket.sendMessage(ownerId, { text: `🔔 *Notification:*\n\n${data.message}` });
                await githubRequest('DELETE', `/repos/${repo}/contents/${file.path}`, { message: "Processed", sha: fileData.sha });
                console.log(`Processed: ${file.name}`);
            }
        } catch (e) {
            if (!e.message.includes('404')) console.error('Poll Error:', e.message);
        }
    }, 20000);
}

startBot();
setInterval(() => console.log(`[Heartbeat] Connected: ${isConnected}, Token: ${!!process.env.GH_TOKEN}`), 60000);
