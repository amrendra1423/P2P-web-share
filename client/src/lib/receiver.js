import { RTC_CONFIG } from './protocol.js';

/**
 * ReceiverSession — joins a share room, receives the file catalog,
 * requests files and assembles incoming chunks into downloadable Blobs.
 */
export class ReceiverSession {
  constructor(signaling, roomId, onUpdate) {
    this.signaling = signaling;
    this.roomId = roomId;
    this.onUpdate = onUpdate;
    this.state = 'connecting'; // connecting | waiting | connected | error | host-left
    this.error = null;
    this.catalog = []; // [{ id, name, size, mime }]
    this.transfers = new Map(); // fileId -> { received, total, status, speed, url, _t, _b, _chunks }
    this.pc = null;
    this.channel = null;
    this._current = null; // fileId currently streaming in
    this._lastNotify = 0;

    signaling.on('joined', () => {
      this.state = 'waiting';
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
    signaling.on('_closed', () => {
      if (this.state === 'connecting' || this.state === 'waiting') {
        this.state = 'error';
        this.error = 'connection-lost';
        this.notify(true);
      }
    });
    signaling.on('signal', (m) => this._onSignal(m.data));
  }

  async start() {
    await this.signaling.ready;
    this.signaling.send({ type: 'join', roomId: this.roomId });
  }

  async _onSignal(data) {
    try {
      if (data.sdp) {
        if (!this.pc) this._createPeer();
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
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.signaling.send({ type: 'signal', data: { candidate: e.candidate } });
    };
    this.pc.ondatachannel = (e) => {
      this.channel = e.channel;
      this.channel.binaryType = 'arraybuffer';
      this.channel.onopen = () => {
        this.state = 'connected';
        this.notify(true);
      };
      this.channel.onclose = () => {
        if (this.state === 'connected') this.state = 'host-left';
        this.notify(true);
      };
      this.channel.onmessage = (e2) => this._onMessage(e2.data);
    };
  }

  _onMessage(data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'catalog':
          this.catalog = msg.files;
          this.notify(true);
          break;
        case 'file-start': {
          const t = this.transfers.get(msg.fileId) ?? {};
          Object.assign(t, {
            name: msg.name,
            mime: msg.mime,
            received: 0,
            total: msg.size,
            status: 'receiving',
            speed: 0,
            url: null,
            _t: performance.now(),
            _b: 0,
            _chunks: [],
          });
          this.transfers.set(msg.fileId, t);
          this._current = msg.fileId;
          this.notify(true);
          break;
        }
        case 'file-end': {
          const t = this.transfers.get(msg.fileId);
          if (!t) return;
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
    // Binary chunk for the file currently streaming
    const t = this.transfers.get(this._current);
    if (!t || !t._chunks) return;
    t._chunks.push(data);
    t.received += data.byteLength;
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
    const existing = this.transfers.get(fileId);
    if (existing && (existing.status === 'receiving' || existing.status === 'queued')) return;
    if (this.channel?.readyState !== 'open') return;
    this.transfers.set(fileId, {
      received: 0,
      total: this.catalog.find((f) => f.id === fileId)?.size ?? 0,
      status: 'queued',
      speed: 0,
      url: null,
      _chunks: [],
    });
    this.channel.send(JSON.stringify({ type: 'request', fileId }));
    this.notify(true);
  }

  requestAll() {
    for (const f of this.catalog) {
      const t = this.transfers.get(f.id);
      if (!t || t.status === 'failed') this.request(f.id);
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
