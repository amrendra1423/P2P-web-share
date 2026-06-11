import {
  CHUNK_SIZE,
  HIGH_WATER,
  LOW_WATER,
  RTC_CONFIG,
  waitForDrain,
} from './protocol.js';
import { generateKey, encryptChunk } from './crypto.js';

/**
 * SenderSession — hosts a share room.
 * - One RTCPeerConnection + DataChannel per receiver.
 * - Every chunk is AES-256-GCM encrypted in-browser before sending
 *   (zero-knowledge: the key lives only in the URL hash).
 * - Supports resume: receivers may request a file from a byte offset.
 */
export class SenderSession {
  constructor(signaling, onUpdate) {
    this.signaling = signaling;
    this.onUpdate = onUpdate;
    this.roomId = null;
    this.key = null; // CryptoKey (AES-GCM)
    this.keyB64 = null; // goes into the share URL hash
    this.files = []; // [{ id, file }]
    this.peers = new Map(); // peerId -> peer state
    this._started = false;
    this._lastNotify = 0;

    signaling.on('created', (m) => {
      this.roomId = m.roomId;
      this.notify(true);
    });
    // If the signaling socket drops and reconnects, the old room is gone —
    // recreate one (the share link updates accordingly).
    signaling.on('_open', () => {
      if (this._started) this.signaling.send({ type: 'create' });
    });
    signaling.on('peer-joined', (m) => this._onPeerJoined(m.peerId));
    signaling.on('peer-left', (m) => this._dropPeer(m.peerId));
    signaling.on('signal', (m) => this._onSignal(m.from, m.data));
  }

  async start() {
    const { key, b64 } = await generateKey();
    this.key = key;
    this.keyB64 = b64;
    await this.signaling.ready;
    this._started = true;
    this.signaling.send({ type: 'create' });
  }

  addFiles(fileList) {
    for (const file of fileList) {
      this.files.push({ id: crypto.randomUUID(), file });
    }
    this._broadcastCatalog();
    this.notify(true);
  }

  removeFile(id) {
    this.files = this.files.filter((f) => f.id !== id);
    this._broadcastCatalog();
    this.notify(true);
  }

  _catalog() {
    return {
      type: 'catalog',
      files: this.files.map(({ id, file }) => ({
        id,
        name: file.name,
        size: file.size,
        mime: file.type,
      })),
    };
  }

  _broadcastCatalog() {
    const msg = JSON.stringify(this._catalog());
    for (const peer of this.peers.values()) {
      if (peer.channel.readyState === 'open') peer.channel.send(msg);
    }
  }

  async _onPeerJoined(peerId) {
    // A reconnecting receiver re-joins with the same peerId — replace the
    // stale connection.
    const stale = this.peers.get(peerId);
    if (stale) {
      try {
        stale.pc.close();
      } catch {}
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const channel = pc.createDataChannel('file');
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;

    const peer = {
      id: peerId,
      pc,
      channel,
      state: 'connecting',
      queue: [], // [{ fileId, offset }]
      sending: false,
      transfers: new Map(), // fileId -> { sent, total, name, status, speed, _t, _b }
    };
    this.peers.set(peerId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.send({ type: 'signal', to: peerId, data: { candidate: e.candidate } });
      }
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        // Only drop if this pc is still the active one for the peer
        if (this.peers.get(peerId)?.pc === pc) this._dropPeer(peerId);
      }
    };
    channel.onopen = () => {
      peer.state = 'connected';
      channel.send(JSON.stringify(this._catalog()));
      this.notify(true);
    };
    channel.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const msg = JSON.parse(e.data);
      if (msg.type === 'request') {
        peer.queue.push({ fileId: msg.fileId, offset: msg.offset || 0 });
        this._processQueue(peer);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.send({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } });
    this.notify(true);
  }

  async _onSignal(from, data) {
    const peer = this.peers.get(from);
    if (!peer) return;
    try {
      if (data.sdp) await peer.pc.setRemoteDescription(data.sdp);
      else if (data.candidate) await peer.pc.addIceCandidate(data.candidate);
    } catch (err) {
      console.error('signal error', err);
    }
  }

  async _processQueue(peer) {
    if (peer.sending) return;
    peer.sending = true;
    while (peer.queue.length) {
      const { fileId, offset } = peer.queue.shift();
      await this._sendFile(peer, fileId, offset);
    }
    peer.sending = false;
  }

  async _sendFile(peer, fileId, startOffset = 0) {
    const entry = this.files.find((f) => f.id === fileId);
    const ch = peer.channel;
    if (!entry || ch.readyState !== 'open') return;
    const { file } = entry;
    if (startOffset > file.size) startOffset = 0;

    const t = {
      name: file.name,
      sent: startOffset,
      total: file.size,
      status: 'sending',
      speed: 0,
      _t: performance.now(),
      _b: startOffset,
    };
    peer.transfers.set(fileId, t);

    ch.send(
      JSON.stringify({
        type: 'file-start',
        fileId,
        name: file.name,
        size: file.size,
        mime: file.type,
        offset: startOffset, // resume point (plaintext bytes)
      })
    );

    let offset = startOffset;
    try {
      while (offset < file.size) {
        if (ch.readyState !== 'open') throw new Error('channel-closed');
        const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        // Zero-knowledge: encrypt before the chunk ever leaves this browser
        const encrypted = await encryptChunk(this.key, chunk);
        if (ch.bufferedAmount > HIGH_WATER) await waitForDrain(ch);
        ch.send(encrypted);
        offset += chunk.byteLength;
        t.sent = offset;
        this._updateSpeed(t);
        this.notify();
      }
      ch.send(JSON.stringify({ type: 'file-end', fileId }));
      t.status = 'done';
      t.speed = 0;
    } catch {
      t.status = 'failed'; // receiver will re-request with an offset to resume
      t.speed = 0;
    }
    this.notify(true);
  }

  _updateSpeed(t) {
    const now = performance.now();
    const dt = now - t._t;
    if (dt >= 500) {
      t.speed = ((t.sent - t._b) / dt) * 1000;
      t._t = now;
      t._b = t.sent;
    }
  }

  _dropPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    for (const t of peer.transfers.values()) {
      if (t.status === 'sending') t.status = 'failed';
    }
    try {
      peer.pc.close();
    } catch {}
    peer.state = 'left';
    this.notify(true);
  }

  /** Throttled re-render trigger (~10/s), immediate when force=true. */
  notify(force = false) {
    const now = performance.now();
    if (!force && now - this._lastNotify < 100) return;
    this._lastNotify = now;
    this.onUpdate();
  }

  destroy() {
    for (const peer of this.peers.values()) {
      try {
        peer.pc.close();
      } catch {}
    }
    this.signaling.close();
  }
}
