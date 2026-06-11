/**
 * P2P Web Share — Signaling Server
 *
 * Coordinates the WebRTC handshake between a sender (room host) and any
 * number of receivers. Relays only small JSON signaling messages
 * (offers / answers / ICE candidates). File data NEVER passes through
 * this server — it flows browser-to-browser over WebRTC DataChannels.
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();

// Serve the built client (production mode). In dev, Vite serves the client.
const clientDist = join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

/** roomId -> { host: ws, peers: Map<peerId, ws> } */
const rooms = new Map();

const genRoomId = () => randomBytes(4).toString('hex'); // 8-char room id
const genPeerId = () => randomBytes(6).toString('hex');

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  ws.peerId = genPeerId();
  ws.roomId = null;
  ws.isHost = false;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      // Sender creates a share room
      case 'create': {
        let roomId = genRoomId();
        while (rooms.has(roomId)) roomId = genRoomId();
        rooms.set(roomId, { host: ws, peers: new Map() });
        ws.roomId = roomId;
        ws.isHost = true;
        send(ws, { type: 'created', roomId, peerId: ws.peerId });
        break;
      }

      // Receiver joins an existing room
      case 'join': {
        const room = rooms.get(msg.roomId);
        if (!room) {
          send(ws, { type: 'error', error: 'room-not-found' });
          return;
        }
        room.peers.set(ws.peerId, ws);
        ws.roomId = msg.roomId;
        send(ws, { type: 'joined', roomId: msg.roomId, peerId: ws.peerId });
        // Tell the host a new peer wants to connect
        send(room.host, { type: 'peer-joined', peerId: ws.peerId });
        break;
      }

      // Relay WebRTC signaling (offer / answer / ICE) between peers
      case 'signal': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const target = ws.isHost ? room.peers.get(msg.to) : room.host;
        send(target, { type: 'signal', from: ws.peerId, data: msg.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    if (ws.isHost) {
      // Host left: close the room, notify all receivers
      for (const peer of room.peers.values()) {
        send(peer, { type: 'host-left' });
      }
      rooms.delete(ws.roomId);
    } else {
      room.peers.delete(ws.peerId);
      send(room.host, { type: 'peer-left', peerId: ws.peerId });
    }
  });
});

// Heartbeat: drop dead connections so rooms get cleaned up
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

httpServer.listen(PORT, () => {
  console.log(`P2P Web Share signaling server on http://localhost:${PORT}`);
});
