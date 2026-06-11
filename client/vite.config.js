import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy signaling WebSocket to the Node server during development
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
