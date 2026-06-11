# P2P Web Share

## Live demo

- **App (frontend):** https://p2pbrowser.netlify.app
- **Signaling server (backend):** https://p2p-web-share-05dh.onrender.com
  (free tier — first load may take ~50 s while it wakes up)

Direct browser-to-browser file transfer over WebRTC. Drop a file, get a share
link + QR code; anyone who opens the link streams the file straight from your
browser. The Node.js signaling server only coordinates the WebRTC handshake —
it never reads, processes, or stores file data.

## Features

- Multiple files per room, multiple simultaneous receivers
- Chunked DataChannel streaming (64 KB chunks) with backpressure handling
- **Zero-knowledge encryption** — every chunk is AES-256-GCM encrypted in the
  sender's browser (Web Crypto API). The key is generated client-side and
  travels only in the URL hash (`#roomId/key`), which browsers never send in
  HTTP requests — the server cannot decrypt anything, ever.
- **Connection churn recovery (auto-resume)** — if the peer connection or
  signaling socket drops mid-transfer, downloads pause, the receiver re-joins
  the room automatically and re-requests each file from the last received
  byte offset instead of restarting from 0%.
- Live progress bars and transfer speed on both sides
- QR code for opening the room on another device
- Rooms live only while the sender's tab is open — nothing is stored anywhere

## Architecture

```
sender browser ──(AES-GCM encrypted chunks, WebRTC DataChannel)──> receiver browser(s)
       \                                                            /
        \────(offer/answer/ICE via WebSocket)──> signaling server </
                      (never sees file data or the key)
```

- `server/` — Express + ws signaling server. Manages rooms, relays SDP
  offers/answers and ICE candidates. Also serves the built client.
- `client/` — React (Vite) app. One `RTCPeerConnection` + DataChannel per
  receiver.

### Transfer protocol (per DataChannel)

1. sender → receiver: `catalog` (file list)
2. receiver → sender: `request { fileId, offset }` (offset > 0 = resume)
3. sender → receiver: `file-start { fileId, name, size, offset }`
4. binary messages: `12-byte IV ‖ AES-GCM ciphertext` per 64 KB chunk
5. sender → receiver: `file-end` → receiver assembles Blob and downloads

### Key files

- `client/src/lib/crypto.js` — AES-256-GCM key generation, chunk encrypt/decrypt
- `client/src/lib/sender.js` / `receiver.js` — transfer engine, resume logic
- `client/src/lib/signaling.js` — auto-reconnecting WebSocket wrapper
- `server/index.js` — room management + signaling relay

## Run (development)

```bash
# terminal 1 — signaling server on :3001
cd server && npm install && npm start

# terminal 2 — client dev server on :5173 (proxies /ws to :3001)
cd client && npm install && npm run dev
```

Open http://localhost:5173, drop files, and open the generated
`#roomId/key` link in another tab/browser/device.

## Run (production)

```bash
cd client && npm install && npm run build   # outputs client/dist
cd ../server && npm install && npm start    # serves client + signaling on :3001
```

Open http://localhost:3001.

## Deploy

- **Frontend (Netlify):** base directory `client`, build `npm run build`,
  publish `client/dist`. Set env var `VITE_SIGNALING_URL` to your backend
  WebSocket URL, e.g. `wss://your-app.onrender.com`.
- **Backend (Render):** root directory `server`, build `npm install`,
  start `npm start`.

## Notes

- Web Crypto and WebRTC require a secure context: localhost or HTTPS.
  For LAN testing across devices use a tunnel like `ngrok`, or deploy.
- Only STUN is configured. Peers behind symmetric NATs may need a TURN
  server — add one to `RTC_CONFIG` in `client/src/lib/protocol.js`.
- Received files are assembled in memory; very large files (multi-GB) are
  limited by browser RAM.
