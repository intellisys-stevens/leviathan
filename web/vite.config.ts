import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': import.meta.dirname,
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:1397',
      '/healthz': 'http://127.0.0.1:1397',
    },
  },
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    sourcemap: false,
    // Keep bundled fonts as same-origin files so the dashboard remains
    // compatible with the server's strict `font-src 'self'` CSP.
    assetsInlineLimit: 0,
  },
});
