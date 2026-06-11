import { formatBytes, formatSpeed } from '../lib/protocol.js';

export default function Progress({ done, total, speed, status }) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="progress-wrap">
      <div className="progress-bar">
        <div
          className={`progress-fill ${status === 'failed' ? 'failed' : ''} ${
            status === 'done' ? 'done' : ''
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="progress-meta">
        <span>
          {formatBytes(done)} / {formatBytes(total)} ({pct.toFixed(0)}%)
        </span>
        {status === 'sending' || status === 'receiving' ? (
          <span className="speed">{formatSpeed(speed)}</span>
        ) : (
          <span className={`status-${status}`}>
            {status === 'done' ? '✓ complete' : status === 'failed' ? '✗ failed' : status}
          </span>
        )}
      </div>
    </div>
  );
}
