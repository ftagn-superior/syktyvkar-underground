import { buildWorld } from './index.js';
const variant = process.argv[2] ?? 'hill';
if (variant !== 'hill' && variant !== 'flat')
  throw new Error('Usage: pnpm world:terrain [hill|flat] [output]');
const output = process.argv[3] ?? `dist/worlds/terrain-lab${variant === 'flat' ? '-flat' : ''}`;
const manifest = await buildWorld('content/worlds/terrain-lab/world.json', output, {
  terrainVariant: variant,
});
console.log(
  JSON.stringify({
    variant,
    output,
    mapVersion: manifest.mapVersion,
    simulationConfigHash: manifest.simulationConfigHash,
  }),
);
