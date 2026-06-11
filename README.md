# P2P Web Share

Direct browser-to-browser file transfer over WebRTC. Drop a file, get a share
link + QR code; anyone who opens the link streams the file straight from your
browser. The Node.js signaling server only coordinates the WebRTC handshake —
it never reads, processes, or stores file data.

## Features

- Multiple files per room, multiple simultaneous receivers
- Chunked DataChannel streaming (64 KB chunks) with backpressure handling
- Live progress bars and transfer speed on both sides
- QR code for opening the room on another device
- Rooms live only while the sender's tab is open — nothing is stored anywhere

## Architecture

```
sender browser  ──(file chunks, WebRTC DataChannel)──>  receiver browser(s)
       \                                                  /
        \──(offer/answer/ICE via WebSocket)──> signaling server <──/
```

- `server/` — Express + ws signaling server. Manages rooms, relays SDP
  offers/answers and ICE candidates. Also serves the built client.
- `client/` — React (Vite) app. One `RTCPeerConnection` + DataChannel per
  receiver. Protocol: sender pushes a file `catalog`; receiver sends
  `request`; sender streams `file-start` → binary chunks → `file-end`.

## Run (development)

```bash
# terminal 1 — signaling server on :3001
cd server && npm install && npm start

# terminal 2 — client dev server on :5173 (proxies /ws to :3001)
cd client && npm install && npm run dev
```

Open http://localhost:5173, drop files, and open the generated `#roomId` link
in another tab/browser/device.

## Run (production)

```bash
cd client && npm install && npm run build   # outputs client/dist
cd ../server && npm install && npm start    # serves client + signaling on :3001
```

Open http://localhost:3001.

## Notes

- To share across devices on a LAN, open the app via your machine's LAN IP.
  WebRTC DataChannels require a secure context except on localhost, so for
  non-localhost use serve over HTTPS (or use a tunnel like `ngrok`).
- Only STUN is configured. Peers behind symmetric NATs may need a TURN server —
  add one to `RTC_CONFIG` in `client/src/lib/protocol.js`.
- Received files are assembled in memory; very large files (multi-GB) are
  limited by browser memory.
