import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/simulation/package.json', import.meta.url));
await viteBuild({ configFile: 'apps/client/vite.config.ts' });
await mkdir('dist/server', { recursive: true });
await bundle({
  entryPoints: {
    main: 'apps/server/src/main.ts',
    migrate: 'apps/server/src/migrate.ts',
    'migrate-world': 'apps/server/src/migrate-world.ts',
    'layout-command': 'apps/server/src/layout-command.ts',
    'preparation-worker': 'apps/server/src/layout/preparation-worker.ts',
  },
  outdir: 'dist/server',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external: ['bufferutil', 'utf-8-validate', 'msgpackr-extract'],
  banner: {
    js: "import { createRequire as createBundleRequire } from 'node:module'; const require = createBundleRequire(import.meta.url);",
  },
});
await cp(
  require.resolve('@babylonjs/havok/lib/esm/HavokPhysics.wasm'),
  'dist/server/HavokPhysics.wasm',
);
console.log('Built client, server and versioned world. Run pnpm start.');
