const express = require('express');
const app = express();
const port = process.env.PORT || 8080;

app.get('/', (req, res) => {
    res.send('Perpetual Relay Active');
});

const server = app.listen(port, () => {
    console.log(`[${new Date().toISOString()}] Server running on port ${port}`);
});

// Periodic Heartbeat
setInterval(() => {
    console.log(`[${new Date().toISOString()}] Heartbeat: Process is alive and running...`);
}, 60000); // Every minute

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    server.close(() => {
        process.exit(0);
    });
});
