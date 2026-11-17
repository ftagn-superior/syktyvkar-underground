import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { inspectReactionCatalog } from '../../tools/reactions/catalog';
import { buildIdentity } from '../../tools/build-identity';

export default defineConfig(async () => {
  const release = await inspectReactionCatalog(fileURLToPath(new URL('../..', import.meta.url)));
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    define: {
      __SU_BUILD_INFO__: JSON.stringify(buildIdentity()),
      __SU_REACTION_CATALOG_VERSION__: JSON.stringify(release.version),
    },
    plugins: [
      {
        name: 'reaction-release',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'reaction-release.json',
            source: JSON.stringify({ formatVersion: 1, version: release.version }),
          });
        },
      },
    ],
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
    build: {
      outDir: '../../dist/client',
      emptyOutDir: true,
      target: 'es2022',
      assetsInlineLimit: 0,
    },
  };
});
