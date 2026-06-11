// Shared constants & helpers for the DataChannel file-transfer protocol.
//
// Wire protocol (over one ordered, reliable RTCDataChannel per receiver):
//   JSON (string) control messages:
//     sender -> receiver: { type:'catalog', files:[{id,name,size,mime}] }
//     receiver -> sender: { type:'request', fileId }
//     sender -> receiver: { type:'file-start', fileId, name, size, mime }
//     sender -> receiver: { type:'file-end', fileId }
//   Binary (ArrayBuffer) messages: raw file chunks, in order, between
//   file-start and file-end. Only one file streams at a time per channel.

export const CHUNK_SIZE = 64 * 1024;        // 64 KB chunks
export const HIGH_WATER = 8 * 1024 * 1024;  // pause sending above 8 MB buffered
export const LOW_WATER = 1 * 1024 * 1024;   // resume below 1 MB

export const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

export const formatSpeed = (bps) => (bps > 0 ? `${formatBytes(bps)}/s` : '');

/** Wait until the channel's buffered amount drains below LOW_WATER. */
export function waitForDrain(channel) {
  return new Promise((resolve) => {
    if (channel.bufferedAmount <= LOW_WATER) return resolve();
    const onLow = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      resolve();
    };
    channel.addEventListener('bufferedamountlow', onLow);
  });
}
