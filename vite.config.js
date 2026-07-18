import { defineConfig } from 'vite';
import { embedProxyPlugin } from './plugins/embed-proxy.js';

export default defineConfig({
  plugins: [embedProxyPlugin()],
  server: {
    port: 5173,
    open: true,
  },
  preview: {
    port: 4173,
  },
});
