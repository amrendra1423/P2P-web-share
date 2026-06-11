import { RTC_CONFIG } from './protocol.js';
import { importKey, decryptChunk } from './crypto.js';

/**
 * ReceiverSession — joins a share room, receives the encrypted file stream,
 * decrypts chunks in-browser (AES-256-GCM, key from URL hash only) and
 * assembles them into downloadable Blobs.
 *
 * Connection churn recovery: if the peer connection or signaling socket
 * drops mid-transfer, in-flight downloads are paused, the session re-joins
 * the room automatically and re-requests each file from the last received
 * byte offset — no restart from 0%.
 */
export class ReceiverSession {
  constructor(signaling, roomId, keyB64, onUpdate) {
    this.signaling = signaling;
    this.roomId = roomId;
    this.keyB64 = keyB64;
    this.key = null;
    this.onUpdate = onUpdate;
    // connecting | waiting | connected | reconnecting | error | host-left
    this.state = 'connecting';
    this.error = null;
    this.catalog = []; // [{ id, name, size, mime }]
    this.transfers = new Map(); // fileId -> transfer state
    this.pc = null;
    this.channel = null;
    this._current = null; // fileId currently streaming in
    this._queue = Promise.resolve(); // serializes async message handling
    this._joined = false;
    this._lastNotify = 0;

    signaling.on('joined', () => {
      this._joined = true;
      if (this.state === 'connecting') this.state = 'waiting';
      this.notify(true);
    });
    signaling.on('error', (m) => {
      this.state = 'error';
      this.error = m.error;
      this.notify(true);
    });
    signaling.on('host-left', () => {
      this.state = 'host-left';
      this.notify(true);
    });
    // Signaling reconnected (it auto-retries): re-join the room
    signaling.on('_open', () => {
      if (this._joined && this.state !== 'host-left' && this.state !== 'error') {
        this.signaling.send({ type: 'join', roomId: this.roomId });
      }
    });
    signaling.on('signal', (m) => this._onSignal(m.data));
  }

  async start() {
    if (!this.keyB64) {
      this.state = 'error';
      this.error = 'invalid-link';
      this.notify(true);
      return;
    }
    try {
      this.key = await importKey(this.keyB64);
    } catch {
      this.state = 'error';
      this.error = 'invalid-link';
      this.notify(true);
      return;
    }
    await this.signaling.ready;
    this.signaling.send({ type: 'join', roomId: this.roomId });
  }

  async _onSignal(data) {
    try {
      if (data.sdp) {
        // A fresh offer means the sender built a new connection (first join
        // or reconnect) — always start from a clean RTCPeerConnection.
        if (data.sdp.type === 'offer') this._createPeer();
        await this.pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.signaling.send({ type: 'signal', data: { sdp: this.pc.localDescription } });
        }
      } else if (data.candidate) {
        await this.pc?.addIceCandidate(data.candidate);
      }
    } catch (err) {
      console.error('signal error', err);
    }
  }

  _createPeer() {
    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
    }
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signaling.send({ type: 'signal', data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && ['failed', 'disconnected'].includes(pc.connectionState)) {
        this._handleDisconnect();
      }
    };
    pc.ondatachannel = (e) => {
      this.channel = e.channel;
      this.channel.binaryType = 'arraybuffer';
      this.channel.onopen = () => {
        this.state = 'connected';
        this._resumePaused();
        this.notify(true);
      };
      this.channel.onclose = () => {
        if (this.pc === pc) this._handleDisconnect();
      };
      this.channel.onmessage = (e2) => {
        // Serialize: decryption is async, ordering must be preserved
        this._queue = this._queue
          .then(() => this._handleMessage(e2.data))
          .catch((err) => console.error('rx error', err));
      };
    };
  }

  /** Connection churn: pause in-flight transfers and re-join the room. */
  _handleDisconnect() {
    if (['host-left', 'error'].includes(this.state)) return;
    if (this.state === 'reconnecting') return;
    this.state = 'reconnecting';
    for (const t of this.transfers.values()) {
      if (t.status === 'receiving' || t.status === 'queued') t.status = 'paused';
    }
    this._current = null;
    try {
      this.pc?.close();
    } catch {}
    this.pc = null;
    this.channel = null;
    this.notify(true);
    // If the signaling socket is alive, re-join now; otherwise the '_open'
    // handler re-joins once it reconnects.
    setTimeout(() => {
      if (this.state === 'reconnecting' && this.signaling.isOpen) {
        this.signaling.send({ type: 'join', roomId: this.roomId });
      }
    }, 1000);
  }

  /** After reconnecting, continue paused downloads from the last byte. */
  _resumePaused() {
    for (const [fileId, t] of this.transfers) {
      if (t.status === 'paused') this.request(fileId);
    }
  }

  async _handleMessage(data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'catalog':
          this.catalog = msg.files;
          this.notify(true);
          break;
        case 'file-start': {
          const existing = this.transfers.get(msg.fileId);
          const resuming =
            msg.offset > 0 && existing?._chunks && existing.received === msg.offset;
          const t = resuming ? existing : {};
          if (!resuming) {
            Object.assign(t, { received: 0, url: null, _chunks: [] });
            this.transfers.set(msg.fileId, t);
          }
          Object.assign(t, {
            name: msg.name,
            mime: msg.mime,
            total: msg.size,
            status: 'receiving',
            speed: 0,
            _t: performance.now(),
            _b: t.received,
          });
          this._current = msg.fileId;
          this.notify(true);
          break;
        }
        case 'file-end': {
          const t = this.transfers.get(msg.fileId);
          if (!t || !t._chunks) return;
          const blob = new Blob(t._chunks, { type: t.mime || 'application/octet-stream' });
          t._chunks = null;
          t.url = URL.createObjectURL(blob);
          t.status = 'done';
          t.speed = 0;
          this._current = null;
          this._triggerDownload(t.url, t.name);
          this.notify(true);
          break;
        }
      }
      return;
    }

    // Binary message: encrypted chunk for the file currently streaming
    const t = this.transfers.get(this._current);
    if (!t || !t._chunks) return;
    const plain = await decryptChunk(this.key, data); // throws if tampered
    t._chunks.push(plain);
    t.received += plain.byteLength;
    const now = performance.now();
    const dt = now - t._t;
    if (dt >= 500) {
      t.speed = ((t.received - t._b) / dt) * 1000;
      t._t = now;
      t._b = t.received;
    }
    this.notify();
  }

  request(fileId) {
    const t = this.transfers.get(fileId);
    if (t && ['receiving', 'queued', 'done'].includes(t.status)) return;
    if (this.channel?.readyState !== 'open') return;
    const resumeOffset = t?.status === 'paused' && t._chunks ? t.received : 0;
    if (!resumeOffset) {
      this.transfers.set(fileId, {
        received: 0,
        total: this.catalog.find((f) => f.id === fileId)?.size ?? 0,
        status: 'queued',
        speed: 0,
        url: null,
        _chunks: [],
      });
    } else {
      t.status = 'queued';
    }
    this.channel.send(JSON.stringify({ type: 'request', fileId, offset: resumeOffset }));
    this.notify(true);
  }

  requestAll() {
    for (const f of this.catalog) {
      const t = this.transfers.get(f.id);
      if (!t || t.status === 'failed' || t.status === 'paused') this.request(f.id);
    }
  }

  _triggerDownload(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  notify(force = false) {
    const now = performance.now();
    if (!force && now - this._lastNotify < 100) return;
    this._lastNotify = now;
    this.onUpdate();
  }

  destroy() {
    try {
      this.pc?.close();
    } catch {}
    this.signaling.close();
    for (const t of this.transfers.values()) {
      if (t.url) URL.revokeObjectURL(t.url);
    }
  }
}
