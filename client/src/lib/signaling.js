/**
 * Thin wrapper around the signaling WebSocket with automatic reconnection.
 * Emits: every server message type, plus '_open' (each (re)connect) and
 * '_closed' (each disconnect).
 */
const RETRY_MS = 2000;

export class Signaling {
  constructor() {
    this.handlers = new Map(); // type -> Set<fn>
    this.closed = false;
    this._resolveReady = null;
    this.ready = new Promise((res) => (this._resolveReady = res));
    this._connect();
  }

  _connect() {
    // VITE_SIGNALING_URL lets the frontend (e.g. on Netlify) reach a
    // signaling server hosted elsewhere (e.g. on Render).
    const base =
      import.meta.env.VITE_SIGNALING_URL ||
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    const ws = new WebSocket(`${base.replace(/\/$/, '')}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this._resolveReady?.();
      this._resolveReady = null;
      this._emit('_open', {});
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this._emit(msg.type, msg);
    };
    ws.onclose = () => {
      this._emit('_closed', {});
      if (!this.closed) setTimeout(() => this._connect(), RETRY_MS);
    };
  }

  _emit(type, msg) {
    for (const fn of this.handlers.get(type) ?? []) fn(msg);
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  get isOpen() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(msg) {
    if (this.isOpen) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.closed = true;
    this.ws.close();
  }
}
