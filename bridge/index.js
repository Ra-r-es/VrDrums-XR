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

const udpPort = new osc.UDPPort({
    localAddress: "0.0.0.0",
    localPort: 57121,
    remoteAddress: "127.0.0.1",
    remotePort: 8000,
    metadata: true
});

udpPort.open();
udpPort.on("ready", () => console.log("[OSC] Ready -> 127.0.0.1:8000"));
udpPort.on("error", (err) => console.error("[OSC] Error:", err.message));

let vrClient = null;

io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    socket.on('xrSessionStart', () => {
        vrClient = socket.id;
        console.log(`[XR] VR session started: ${socket.id}`);
    });

    socket.on('xrPose', (data) => {
        socket.broadcast.emit('xrPose', data);
    });

    socket.on('drumHit', (data) => {
        console.log(`[Hit] ${data.instrument} v=${(data.velocity || 0).toFixed(2)}`);
        socket.broadcast.emit('drumHitFeedback', data);
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

    socket.on('disconnect', () => {
        console.log(`[Socket] Disconnected: ${socket.id}`);
        if (socket.id === vrClient) {
            vrClient = null;
            io.emit('xrSessionEnd');
            console.log('[XR] VR session ended');
        }
    });
});

app.get('/status', (req, res) => {
    res.json({
        vrConnected: vrClient !== null,
        vrClientId: vrClient,
        totalClients: io.engine.clientsCount,
        oscTarget: '127.0.0.1:8000'
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Bridge running at http://0.0.0.0:${PORT}`);
    console.log(`[Server] Status: http://localhost:${PORT}/status`);
});
