import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import osc from 'osc';
import cors from 'cors';

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*'
    }
});



const udpPort = new osc.UDPPort({
    localAddress: "0.0.0.0",
    localPort: 57121,
    remoteAddress: "127.0.0.1",
    remotePort: 8000,
    metadata: true
});

udpPort.open();
udpPort.on("ready", () => {
    console.log("OSC client is ready and connected to 127.0.0.1:8000");
});

io.on('connection', (socket) => {
    console.log('Frontend client connected:', socket.id);

    socket.on('drumHit', (data) => {
        console.log(`Received drumHit from ${socket.id}:`, data);


        try {
            udpPort.send({
                address: "/drum/hit",
                args: [
                    { type: "s", value: data.drumName || 'snare' },
                    { type: "f", value: data.velocity || 1.0 }
                ]
            });
            console.log(`Sent OSC: /drum/hit -> [${data.drumName}, ${data.velocity}]`);
        } catch (error) {
            console.error('Error sending OSC message:', error);
        }
    });

    socket.on('disconnect', () => {
        console.log('Frontend client disconnected:', socket.id);
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`WebSocket to OSC Bridge running at http://0.0.0.0:${PORT}`);
});