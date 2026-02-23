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
let logs = [];
const processedSignals = new Set();

// Logger Override
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => {
    const msg = `[LOG] ${new Date().toISOString()}: ${args.join(' ')}`;
    originalLog(msg);
    logs.push(msg);
    if (logs.length > 200) logs.shift();
};
console.error = (...args) => {
    const msg = `[ERR] ${new Date().toISOString()}: ${args.join(' ')}`;
    originalError(msg);
    logs.push(msg);
    if (logs.length > 200) logs.shift();
};

// Global Error Handlers
process.on('uncaughtException', (err) => console.error('Uncaught Panic:', err.message, err.stack));
process.on('unhandledRejection', (reason) => console.error('Unhandled Promise:', reason));

// Express Server
app.get('/', (req, res) => {
    res.send(`<h1>Bot Status</h1><p>Connected: ${isConnected}</p><p><a href="/logs">View Logs</a></p>`);
});

app.get('/logs', (req, res) => {
    res.send(`<html><body style="background:#111;color:#0f0;font-family:monospace;padding:20px;"><h2>Live Cloud Logs</h2><hr/>${logs.reverse().join('<br/>')}</body></html>`);
});

app.get('/qr', async (req, res) => {
    if (currentQr) {
        const qrDataUri = await QRCode.toDataURL(currentQr);
        return res.send(`<img src="${qrDataUri}" />`);
    }
    res.send('No QR active.');
});

app.listen(port, () => console.log(`Server live on ${port}`));

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
    console.log('Initializing Baileys session...');
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
            console.log('QR Code generated. Scan required.');
        }
        if (connection === 'close') {
            isConnected = false;
            const code = lastDisconnect.error?.output?.statusCode;
            console.log(`Connection closed (${code}).`);
            if (code !== DisconnectReason.loggedOut) {
                console.log('Attempting automatic reconnection...');
                startBot();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp Connection Opened!');
            isConnected = true;
            currentQr = null;

            // Welcome alert
            try {
                const ownerId = state.creds.me.id.split(':')[0] + '@s.whatsapp.net';
                await socket.sendMessage(ownerId, { text: '🟢 *Bot Connected to Cloud*' });
            } catch (e) {
                console.error('Failed to send welcome message:', e.message);
            }
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
    });

    // Log Syncer: Commit logs to repo every 5 minutes
    setInterval(async () => {
        if (!process.env.GH_TOKEN || logs.length === 0) return;
        try {
            const repo = process.env.GITHUB_REPOSITORY || "psycho237-prog/perpetual-node-relay";
            const logContent = logs.join('\n');
            const b64 = Buffer.from(logContent).toString('base64');

            // Try to get existing file SHA to update
            let sha = "";
            try {
                const existing = await githubRequest('GET', `/repos/${repo}/contents/cloud-bot-logs.txt`);
                sha = existing.sha;
            } catch (e) { }

            await githubRequest('PUT', `/repos/${repo}/contents/cloud-bot-logs.txt`, {
                message: `Sync Logs [${new Date().toISOString()}]`,
                content: b64,
                sha: sha || undefined
            });
            console.log('[Syncer] Logs synced to repo.');
        } catch (e) {
            originalError('[Syncer] Failed to sync logs:', e.message);
        }
    }, 300000); // 5 minutes

    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
        if (!isConnected || !socket) return;
        console.log('[Poller] Checking for signals...');
        try {
            const repo = process.env.GITHUB_REPOSITORY || "psycho237-prog/perpetual-node-relay";
            const files = await githubRequest('GET', `/repos/${repo}/contents/notifications`);
            if (!files || !Array.isArray(files)) return;

            for (const file of files) {
                if (!file.name.endsWith('.json')) continue;
                if (processedSignals.has(file.name)) continue;

                console.log(`[Poller] Processing signal: ${file.name}`);
                const fileData = await githubRequest('GET', `/repos/${repo}/contents/${file.path}`);
                const data = JSON.parse(Buffer.from(fileData.content, 'base64').toString());
                const ownerId = state.creds.me.id.split(':')[0] + '@s.whatsapp.net';

                await socket.sendMessage(ownerId, { text: `🔔 *Notification:*\n\n${data.message}` });
                processedSignals.add(file.name);

                try {
                    await githubRequest('DELETE', `/repos/${repo}/contents/${file.path}`, { message: "Processed", sha: fileData.sha });
                    console.log(`[Poller] Delivered and deleted: ${file.name}`);
                } catch (delErr) {
                    console.error(`[Poller] Deletion failed for ${file.name}, but marked as processed in memory.`);
                }
            }
        } catch (e) {
            if (!e.message.includes('404')) console.error('Poller Error:', e.message);
        }
    }, 30000);
}

startBot();
setInterval(() => console.log(`[Status] Connected: ${isConnected}, Token OK: ${!!process.env.GH_TOKEN}`), 60000);
