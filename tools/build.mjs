import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { inspectReactionCatalog } from './reactions/catalog.ts';
import { buildIdentity } from './build-identity.ts';
const reactions = await inspectReactionCatalog(process.cwd());
const require = createRequire(new URL('../packages/simulation/package.json', import.meta.url));
await viteBuild({ configFile: 'apps/client/vite.config.ts' });
const clientRelease = JSON.parse(await readFile('dist/client/reaction-release.json', 'utf8'));
if (
  clientRelease.version !== reactions.version ||
  (await inspectReactionCatalog(process.cwd())).version !== reactions.version
)
  throw new Error('Каталог реакций изменился во время сборки клиента; повторите сборку.');
await mkdir('dist/server', { recursive: true });
await bundle({
  entryPoints: {
    main: 'apps/server/src/main.ts',
    migrate: 'apps/server/src/migrate.ts',
    'migrate-world': 'apps/server/src/migrate-world.ts',
    'layout-command': 'apps/server/src/layout-command.ts',
    'preparation-worker': 'apps/server/src/layout/preparation-worker.ts',
    'terrain-command': 'apps/server/src/terrain-command.ts',
  },
  outdir: 'dist/server',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  define: {
    __SU_REACTION_CATALOG_VERSION__: JSON.stringify(reactions.version),
    __SU_BUILD_INFO__: JSON.stringify(buildIdentity()),
  },
  external: ['bufferutil', 'utf-8-validate', 'msgpackr-extract'],
  banner: {
    js: "import { createRequire as createBundleRequire } from 'node:module'; const require = createBundleRequire(import.meta.url);",
  },
});
await cp(
  require.resolve('@babylonjs/havok/lib/esm/HavokPhysics.wasm'),
  'dist/server/HavokPhysics.wasm',
);
if ((await inspectReactionCatalog(process.cwd())).version !== reactions.version)
  throw new Error('Каталог реакций изменился во время сборки сервера; повторите сборку.');
console.log('Built client, server and versioned world. Run pnpm start.');
