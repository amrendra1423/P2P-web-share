import { useEffect, useState } from 'react';
import Sender from './Sender.jsx';
import Receiver from './Receiver.jsx';

const getRoomFromHash = () => location.hash.replace(/^#\/?/, '') || null;

export default function App() {
  const [roomId, setRoomId] = useState(getRoomFromHash);

  useEffect(() => {
    const onHash = () => setRoomId(getRoomFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <a className="logo" href={location.pathname} title="P2P Web Share home">
          <span className="logo-mark">⇄</span> P2P Web Share
        </a>
        <span className="tagline">direct browser-to-browser file transfer</span>
      </header>
      {roomId ? <Receiver roomId={roomId} /> : <Sender />}
      <footer className="footer">
        Files stream peer-to-peer over WebRTC — the server only coordinates the
        handshake and never sees your data.
      </footer>
    </div>
  );
}
