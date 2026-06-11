import { useEffect, useRef } from 'react';
import QR from 'qrcode';

export default function QRCode({ value, size = 160 }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current && value) {
      QR.toCanvas(ref.current, value, {
        width: size,
        margin: 1,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
    }
  }, [value, size]);

  return <canvas ref={ref} className="qr" aria-label={`QR code for ${value}`} />;
}
