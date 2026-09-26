import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: { '/v1': 'http://127.0.0.1:3000', '/v2': 'http://127.0.0.1:3000', '/healthz': 'http://127.0.0.1:3000' } },
});