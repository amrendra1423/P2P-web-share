import { useEffect, useState } from 'react';
import Sender from './Sender.jsx';
import Receiver from './Receiver.jsx';

// Share links look like  #<roomId>/<encryptionKey>
// The hash is never sent to any server, so the key stays between peers.
const parseHash = () => {
  const h = location.hash.replace(/^#\/?/, '');
  if (!h) return null;
  const [roomId, key] = h.split('/');
  return { roomId, key: key || null };
};

export default function App() {
  const [room, setRoom] = useState(parseHash);

  useEffect(() => {
    const onHash = () => setRoom(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <a className="logo" href={location.pathname} title="P2P Web Share home">
          <span className="logo-mark">⇄</span> P2P Web Share
        </a>
        <span className="tagline">direct, end-to-end encrypted browser-to-browser file transfer</span>
      </header>
      {room ? <Receiver roomId={room.roomId} keyB64={room.key} /> : <Sender />}
      <footer className="footer">
        Files stream peer-to-peer over WebRTC, AES-256-GCM encrypted in your
        browser. The server only coordinates the handshake — it never sees
        file data or the encryption key.
      </footer>
    </div>
  );
}
