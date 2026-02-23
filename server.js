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

// Express Server for Health Checks & QR Display
app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send('<h1>WhatsApp Bot Relay Active</h1><p>The bot is successfully connected.</p>');
    }

    if (currentQr) {
        try {
            const qrDataUri = await QRCode.toDataURL(currentQr);
            return res.send(`
                <html>
                    <head>
                        <title>Scan WhatsApp QR</title>
                        <meta http-equiv="refresh" content="10">
                        <style>
                            body { background: #111; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                            img { border: 10px solid white; border-radius: 10px; }
                        </style>
                    </head>
                    <body>
                        <h1>Scan to Connect</h1>
                        <img src="${qrDataUri}" />
                        <p>Refreshing every 10 seconds...</p>
                    </body>
                </html>
            `);
        } catch (err) {
            return res.status(500).send('Error generating QR code');
        }
    }

    res.send('<h1>Initializing...</h1><p>Please wait while the bot prepares the QR code.</p><script>setTimeout(() => location.reload(), 2000)</script>');
});

app.listen(port, () => {
    console.log(`[${new Date().toISOString()}] Health check server running on port ${port}`);
});

function githubRequest(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: urlPath,
            method: method,
            headers: {
                'Authorization': `Bearer ${process.env.GH_TOKEN}`,
                'User-Agent': 'WhatsApp-Bot-Relay',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data ? JSON.parse(data) : null);
                } else {
                    reject(new Error(`GitHub API Error: ${res.statusCode} - ${data}`));
                }
            });
        });

        req.on('error', (e) => reject(e));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
        },
        logger: P({ level: 'silent' })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQr = qr;
            console.log('--- SCAN QR CODE ---');
            qrcode.generate(qr, { small: true });
            console.log('Or visit the server URL to see the QR code on a web page.');
        }
        if (connection === 'close') {
            isConnected = false;
            currentQr = null;
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('opened connection');
            isConnected = true;
            currentQr = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Notification Scanner: Check for files in notifications/ folder (Cloud Polling)
    setInterval(async () => {
        if (!isConnected) {
            console.log(`[${new Date().toISOString()}] Monitor: Waiting for connection...`);
            return;
        }

        if (!process.env.GH_TOKEN) {
            console.error('[Notification] GH_TOKEN is missing in environment.');
            return;
        }

        try {
            const repo = process.env.GITHUB_REPOSITORY || "psycho237-prog/perpetual-node-relay";
            const files = await githubRequest('GET', `/repos/${repo}/contents/notifications`);

            for (const file of files) {
                if (!file.name.endsWith('.json')) continue;

                const contentData = await githubRequest('GET', `/repos/${repo}/contents/${file.path}`);
                const decoded = Buffer.from(contentData.content, 'base64').toString('utf8');
                const data = JSON.parse(decoded);

                const message = data.message || "No message content.";

                // Robust owner ID detection
                const rawId = sock.user.id || state.creds.me.id;
                const ownerId = rawId.split(':')[0].split('@')[0] + '@s.whatsapp.net';

                console.log(`[Cloud Notification] Sending to ${ownerId}: ${message}`);
                await sock.sendMessage(ownerId, { text: `🔔 *Notification:*\n\n${message}` });

                // Delete file via API
                await githubRequest('DELETE', `/repos/${repo}/contents/${file.path}`, {
                    message: "Delete processed notification",
                    sha: contentData.sha
                });
                console.log(`[Cloud Notification] Processed and deleted: ${file.name}`);
            }
        } catch (err) {
            if (!err.message.includes('404')) {
                console.error(`Error polling notifications:`, err.message);
            }
        }
    }, 20000);

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.buttonsResponseMessage?.selectedButtonId || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId;

        console.log(`[Message] From: ${remoteJid}, Text: ${text}`);

        if (text === '.ping') {
            console.log('[Command] Executing .ping');
            await sock.sendMessage(remoteJid, { text: 'pong! 🏓' });
        } else if (text === '.menu') {
            console.log('[Command] Executing .menu');
            await sock.sendMessage(remoteJid, { text: '*Available Commands:*\n\n.ping - Check bot response\n.menu - Show this list' });
        }
    });
}

// Start the bot
connectToWhatsApp();

// Periodic Heartbeat
setInterval(() => {
    console.log(`[${new Date().toISOString()}] Heartbeat: Relay is active (Connected: ${isConnected})`);
}, 60000);
