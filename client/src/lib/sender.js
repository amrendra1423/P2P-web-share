import {
  CHUNK_SIZE,
  HIGH_WATER,
  LOW_WATER,
  RTC_CONFIG,
  waitForDrain,
} from './protocol.js';

/**
 * SenderSession — hosts a share room.
 * Maintains one RTCPeerConnection + DataChannel per receiver and streams
 * requested files in 64 KB chunks with backpressure.
 */
export class SenderSession {
  constructor(signaling, onUpdate) {
    this.signaling = signaling;
    this.onUpdate = onUpdate;
    this.roomId = null;
    this.files = []; // [{ id, file }]
    this.peers = new Map(); // peerId -> peer state
    this._lastNotify = 0;

    signaling.on('created', (m) => {
      this.roomId = m.roomId;
      this.notify(true);
    });
    signaling.on('peer-joined', (m) => this._onPeerJoined(m.peerId));
    signaling.on('peer-left', (m) => this._dropPeer(m.peerId));
    signaling.on('signal', (m) => this._onSignal(m.from, m.data));
  }

  async start() {
    await this.signaling.ready;
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
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const channel = pc.createDataChannel('file');
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;

    const peer = {
      id: peerId,
      pc,
      channel,
      state: 'connecting',
      queue: [],
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
        this._dropPeer(peerId);
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
        peer.queue.push(msg.fileId);
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
      await this._sendFile(peer, peer.queue.shift());
    }
    peer.sending = false;
  }

  async _sendFile(peer, fileId) {
    const entry = this.files.find((f) => f.id === fileId);
    const ch = peer.channel;
    if (!entry || ch.readyState !== 'open') return;
    const { file } = entry;

    const t = {
      name: file.name,
      sent: 0,
      total: file.size,
      status: 'sending',
      speed: 0,
      _t: performance.now(),
      _b: 0,
    };
    peer.transfers.set(fileId, t);

    ch.send(
      JSON.stringify({ type: 'file-start', fileId, name: file.name, size: file.size, mime: file.type })
    );

    let offset = 0;
    try {
      while (offset < file.size) {
        if (ch.readyState !== 'open') throw new Error('channel-closed');
        const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        if (ch.bufferedAmount > HIGH_WATER) await waitForDrain(ch);
        ch.send(chunk);
        offset += chunk.byteLength;
        t.sent = offset;
        this._updateSpeed(t);
        this.notify();
      }
      ch.send(JSON.stringify({ type: 'file-end', fileId }));
      t.status = 'done';
      t.speed = 0;
    } catch {
      t.status = 'failed';
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
