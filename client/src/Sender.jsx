import { useEffect, useRef, useState, useCallback } from 'react';
import { Signaling } from './lib/signaling.js';
import { SenderSession } from './lib/sender.js';
import { formatBytes } from './lib/protocol.js';
import QRCode from './components/QRCode.jsx';
import Progress from './components/Progress.jsx';

export default function Sender() {
  const sessionRef = useRef(null);
  const inputRef = useRef(null);
  const [, setTick] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const session = new SenderSession(new Signaling(), () => setTick((t) => t + 1));
    sessionRef.current = session;
    session.start().catch(console.error);
    return () => session.destroy();
  }, []);

  const session = sessionRef.current;

  const addFiles = useCallback((fileList) => {
    if (fileList?.length) sessionRef.current?.addFiles([...fileList]);
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  // Key travels only in the hash — never sent to the server
  const shareUrl =
    session?.roomId && session?.keyB64
      ? `${location.origin}${location.pathname}#${session.roomId}/${session.keyB64}`
      : null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const files = session?.files ?? [];
  const peers = [...(session?.peers.values() ?? [])].filter((p) => p.state !== 'left');

  return (
    <main className="panel">
      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <div className="dropzone-icon">📁</div>
        <p>
          <strong>Drop files here</strong> or click to browse
        </p>
        <p className="hint">Files are shared directly from this tab — keep it open.</p>
      </div>

      {files.length > 0 && (
        <section className="card">
          <h2>Shared files ({files.length})</h2>
          <ul className="file-list">
            {files.map(({ id, file }) => (
              <li key={id} className="file-row">
                <span className="file-name" title={file.name}>
                  {file.name}
                </span>
                <span className="file-size">{formatBytes(file.size)}</span>
                <button
                  className="btn-icon"
                  title="Remove"
                  onClick={() => session.removeFile(id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {files.length > 0 && shareUrl && (
        <section className="card share-card">
          <h2>
            Share link <span className="badge e2e">🔒 end-to-end encrypted</span>
          </h2>
          <p className="hint">
            The decryption key is embedded after the “/” in the link and never
            reaches the server.
          </p>
          <div className="share-row">
            <div className="share-link-col">
              <code className="share-url">{shareUrl}</code>
              <button className="btn" onClick={copyLink}>
                {copied ? '✓ Copied' : 'Copy link'}
              </button>
            </div>
            <QRCode value={shareUrl} />
          </div>
        </section>
      )}

      {files.length > 0 && (
        <section className="card">
          <h2>
            Receivers{' '}
            <span className="badge">{peers.filter((p) => p.state === 'connected').length}</span>
          </h2>
          {peers.length === 0 ? (
            <p className="hint">Waiting for someone to open the link…</p>
          ) : (
            peers.map((peer) => (
              <div key={peer.id} className="peer">
                <div className="peer-head">
                  <span className={`dot ${peer.state}`} />
                  Peer {peer.id.slice(0, 6)} — {peer.state}
                </div>
                {[...peer.transfers.entries()].map(([fid, t]) => (
                  <div key={fid} className="transfer">
                    <span className="file-name" title={t.name}>
                      {t.name}
                    </span>
                    <Progress done={t.sent} total={t.total} speed={t.speed} status={t.status} />
                  </div>
                ))}
              </div>
            ))
          )}
        </section>
      )}
    </main>
  );
}
