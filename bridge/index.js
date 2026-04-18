// ============================================================
// WebSocket-to-OSC Bridge Server
// ============================================================
// Responsibilities:
//   1. Relay drum hit events from Three.js to Pure Data via OSC
//   2. Relay VR pose data to spectator browsers (mirror system)
//   3. Broadcast hit feedback to spectators for visual sync
//
// OSC message format sent to Pd:
//   /drum/hit <instrument:string> <velocity:float> <x:float> <y:float> <z:float>
//
// Socket.IO events:
//   drumHit       - VR client -> server -> OSC + broadcast
//   xrPose        - VR client -> broadcast to spectators
//   xrSessionStart/End - VR session lifecycle
//   drumHitFeedback    - server -> spectators (visual sync)
//   xrSessionEnd       - server -> spectators (VR disconnected)
// ============================================================

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import osc from 'osc';
import cors from 'cors';

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// ============================================================
// OSC connection to Pure Data
// ============================================================
const udpPort = new osc.UDPPort({
    localAddress: "0.0.0.0",
    localPort: 57121,
    remoteAddress: "127.0.0.1",
    remotePort: 8000,
    metadata: true
});

udpPort.open();
udpPort.on("ready", () => {
    console.log("[OSC] Ready -> 127.0.0.1:8000");
});
udpPort.on("error", (err) => {
    console.error("[OSC] Error:", err.message);
});

// ============================================================
// Socket.IO connection handling
// ============================================================
let vrClient = null; // Track the active VR session

io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // --- VR Session Lifecycle ---
    socket.on('xrSessionStart', () => {
        vrClient = socket.id;
        console.log(`[XR] VR session started: ${socket.id}`);
    });

    // --- Relay VR camera pose to all spectators ---
    socket.on('xrPose', (data) => {
        socket.broadcast.emit('xrPose', data);
    });

    // --- Drum Hit: forward to OSC + broadcast to spectators ---
    socket.on('drumHit', (data) => {
        console.log(`[Hit] ${data.instrument} v=${(data.velocity || 0).toFixed(2)}`);

        // Broadcast visual feedback to spectator browsers
        socket.broadcast.emit('drumHitFeedback', data);

        // Send to Pure Data via OSC
        try {
            udpPort.send({
                address: "/drum/hit",
                args: [
                    { type: "s", value: data.instrument || 'snare' },
                    { type: "f", value: data.velocity  || 1.0 },
                    { type: "f", value: data.x || 0 },
                    { type: "f", value: data.y || 0 },
                    { type: "f", value: data.z || 0 }
                ]
            });
        } catch (err) {
            console.error('[OSC] Send error:', err.message);
        }
    });

    // --- Cleanup on disconnect ---
    socket.on('disconnect', () => {
        console.log(`[Socket] Disconnected: ${socket.id}`);
        if (socket.id === vrClient) {
            vrClient = null;
            // Notify spectators that VR session ended
            io.emit('xrSessionEnd');
            console.log('[XR] VR session ended, spectators notified');
        }
    });
});

// ============================================================
// Status endpoint for debugging
// ============================================================
app.get('/status', (req, res) => {
    res.json({
        vrConnected: vrClient !== null,
        vrClientId: vrClient,
        totalClients: io.engine.clientsCount,
        oscTarget: '127.0.0.1:8000'
    });
});

// ============================================================
// Start server
// ============================================================
const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Bridge running at http://0.0.0.0:${PORT}`);
    console.log(`[Server] Status: http://localhost:${PORT}/status`);
});
