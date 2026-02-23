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
const { execSync } = require('child_process');
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
        printQRInTerminal: true,
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
        if (!isConnected || !process.env.GH_TOKEN) return;

        try {
            // 1. List files in notifications folder via API
            const repo = process.env.GITHUB_REPOSITORY || "psycho237-prog/perpetual-node-relay";
            const filesJson = execSync(`gh api /repos/${repo}/contents/notifications`).toString();
            const files = JSON.parse(filesJson);

            for (const file of files) {
                if (!file.name.endsWith('.json')) continue;

                // 2. Fetch file content
                const contentJson = execSync(`gh api /repos/${repo}/contents/${file.path}`).toString();
                const contentData = JSON.parse(contentJson);
                const decoded = Buffer.from(contentData.content, 'base64').toString('utf8');
                const data = JSON.parse(decoded);

                const message = data.message || "No message content.";
                const ownerId = sock.user.id.split(':')[0] + '@s.whatsapp.net';

                console.log(`[Cloud Notification] Sending: ${message}`);
                await sock.sendMessage(ownerId, { text: `🔔 *Notification:*\n\n${message}` });

                // 3. Delete file via API
                execSync(`gh api --method DELETE /repos/${repo}/contents/${file.path} -f message="Delete processed notification" -f sha="${contentData.sha}"`);
            }
        } catch (err) {
            // Ignore 404s if folder is empty/not found
            if (!err.message.includes('404')) {
                console.error(`Error polling notifications:`, err.message);
            }
        }
    }, 20000); // Check every 20 seconds

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text === '.ping') {
            await sock.sendMessage(remoteJid, { text: 'pong! 🏓' });
        } else if (text === '.menu') {
            await sock.sendMessage(remoteJid, { text: '*Available Commands:*\n\n.ping - Check bot response\n.menu - Show this list' });
        }
    });
}

// Start the bot
connectToWhatsApp();

// Periodic Heartbeat
setInterval(() => {
    console.log(`[${new Date().toISOString()}] Heartbeat: Relay is active...`);
}, 60000);
