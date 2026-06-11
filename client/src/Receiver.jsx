import { useEffect, useRef, useState } from 'react';
import { Signaling } from './lib/signaling.js';
import { ReceiverSession } from './lib/receiver.js';
import { formatBytes } from './lib/protocol.js';
import Progress from './components/Progress.jsx';

const STATUS_TEXT = {
  connecting: 'Connecting to room…',
  waiting: 'Connecting to sender…',
  'host-left': 'The sender closed the room.',
};

export default function Receiver({ roomId }) {
  const sessionRef = useRef(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const session = new ReceiverSession(new Signaling(), roomId, () => setTick((t) => t + 1));
    sessionRef.current = session;
    session.start().catch(console.error);
    return () => session.destroy();
  }, [roomId]);

  const s = sessionRef.current;
  if (!s) return null;

  if (s.state === 'error') {
    return (
      <main className="panel">
        <div className="card center">
          <h2>Room not found</h2>
          <p className="hint">
            This link may have expired — share rooms only live while the sender's tab is open.
          </p>
          <a className="btn" href={location.pathname}>
            Share your own files
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="panel">
      <section className="card">
        <h2>
          Room <code>{roomId}</code>
          <span className={`dot ${s.state === 'connected' ? 'connected' : 'connecting'}`} />
        </h2>
        {s.state !== 'connected' && <p className="hint">{STATUS_TEXT[s.state] ?? s.state}</p>}

        {s.catalog.length > 0 && (
          <>
            <div className="row-spread">
              <h3>
                Available files ({s.catalog.length},{' '}
                {formatBytes(s.catalog.reduce((a, f) => a + f.size, 0))})
              </h3>
              <button className="btn" onClick={() => s.requestAll()}>
                Download all
              </button>
            </div>
            <ul className="file-list">
              {s.catalog.map((f) => {
                const t = s.transfers.get(f.id);
                return (
                  <li key={f.id} className="file-row column">
                    <div className="row-spread">
                      <span className="file-name" title={f.name}>
                        {f.name}
                      </span>
                      <span className="file-size">{formatBytes(f.size)}</span>
                      {!t || t.status === 'failed' ? (
                        <button className="btn" onClick={() => s.request(f.id)}>
                          {t?.status === 'failed' ? 'Retry' : 'Download'}
                        </button>
                      ) : t.status === 'done' ? (
                        <a className="btn" href={t.url} download={f.name}>
                          Save again
                        </a>
                      ) : (
                        <span className="hint">{t.status}…</span>
                      )}
                    </div>
                    {t && t.status !== 'queued' && (
                      <Progress
                        done={t.received}
                        total={t.total}
                        speed={t.speed}
                        status={t.status === 'receiving' ? 'receiving' : t.status}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {s.state === 'connected' && s.catalog.length === 0 && (
          <p className="hint">Connected — waiting for the sender to add files.</p>
        )}
      </section>
    </main>
  );
}
