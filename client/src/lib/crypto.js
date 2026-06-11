// Zero-knowledge encryption layer (Web Crypto API, AES-256-GCM).
//
// The sender generates a random key in the browser and puts it ONLY in the
// URL hash (#roomId/key). URL hashes are never sent in HTTP requests and the
// key is never included in any signaling message, so the server has zero
// knowledge of it. Every file chunk is encrypted before it leaves the
// sender's browser: wire format = 12-byte random IV || ciphertext+GCM tag.

const IV_LENGTH = 12;

const toB64Url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromB64Url = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** Generate a fresh AES-256-GCM key. Returns { key, b64 } */
export async function generateKey() {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const raw = await crypto.subtle.exportKey('raw', key);
  return { key, b64: toB64Url(raw) };
}

/** Import a key from its base64url form (taken from the URL hash). */
export function importKey(b64) {
  return crypto.subtle.importKey('raw', fromB64Url(b64), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Encrypt one chunk: returns ArrayBuffer of IV || ciphertext+tag. */
export async function encryptChunk(key, plainBuf) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBuf);
  const out = new Uint8Array(IV_LENGTH + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_LENGTH);
  return out.buffer;
}

/** Decrypt one chunk (IV || ciphertext+tag) back to a plaintext ArrayBuffer. */
export function decryptChunk(key, wireBuf) {
  const buf = new Uint8Array(wireBuf);
  const iv = buf.slice(0, IV_LENGTH);
  const ct = buf.slice(IV_LENGTH);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
}
