/** Thin wrapper around the signaling WebSocket. */
export class Signaling {
  constructor() {
    this.handlers = new Map(); // msg.type -> Set<fn>
    // VITE_SIGNALING_URL lets the frontend (e.g. on Netlify) reach a
    // signaling server hosted elsewhere (e.g. on Render).
    const base =
      import.meta.env.VITE_SIGNALING_URL ||
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    this.ws = new WebSocket(`${base.replace(/\/$/, '')}/ws`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('signaling-failed'));
    });
    this.ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      for (const fn of this.handlers.get(msg.type) ?? []) fn(msg);
    };
    this.ws.onclose = () => {
      for (const fn of this.handlers.get('_closed') ?? []) fn({});
    };
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.ws.close();
  }
}
