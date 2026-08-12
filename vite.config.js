import { defineConfig } from 'vite';
import { authApiPlugin } from './plugins/auth-api.js';
import { embedProxyPlugin } from './plugins/embed-proxy.js';

export default defineConfig({
  plugins: [authApiPlugin(), embedProxyPlugin()],
  server: {
    port: 5173,
    open: true,
  },
  preview: {
    port: 4173,
  },
});
