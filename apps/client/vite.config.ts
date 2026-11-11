import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  define: {
    __SU_BUILD_INFO__: JSON.stringify({ version, builtAt: new Date().toISOString() }),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:2567',
      '/health': 'http://127.0.0.1:2567',
      '/worlds': 'http://127.0.0.1:2567',
      '/matchmake': 'http://127.0.0.1:2567',
      '^/(?!src/|@|node_modules/|assets/)[^/]+/[^/]+$': {
        target: 'http://127.0.0.1:2567',
        ws: true,
      },
    },
  },
  build: { outDir: '../../dist/client', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
});
