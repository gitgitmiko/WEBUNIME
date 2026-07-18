import { defineConfig } from 'vite';
import { embedProxyPlugin } from './plugins/embed-proxy.js';
import { catalogSyncPlugin } from './plugins/catalog-sync.js';

export default defineConfig({
  plugins: [catalogSyncPlugin(), embedProxyPlugin()],
  server: {
    port: 5173,
    open: true,
  },
  preview: {
    port: 4173,
  },
});
