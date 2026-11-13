import {
  createGameServer as createServer,
  type GameServerOptions,
} from '../../apps/server/src/index.js';
import { createDatabaseFixture } from './database-fixture.js';
import { basename, join } from 'node:path';

export async function createGameServer(options: GameServerOptions = {}) {
  const worldDirectory = options.worldDirectory ?? 'dist/worlds/physics-lab';
  options = {
    ...options,
    worldDirectory,
    modelCatalogDirectory:
      options.modelCatalogDirectory ??
      (worldDirectory.startsWith('dist/worlds/')
        ? join('dist/model-catalogs', basename(worldDirectory))
        : join(worldDirectory, 'model-catalog')),
  };
  if (options.pool || options.accounts || !process.env.SU_TEST_DATABASE_URL)
    return createServer(options);
  const fixture = await createDatabaseFixture();
  try {
    const app = await createServer({ ...options, pool: fixture.pool });
    let closed: Promise<void> | undefined;
    return { ...app, close: () => (closed ??= app.close().finally(() => fixture.close())) };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
