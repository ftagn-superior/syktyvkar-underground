import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { MAX_PLAYERS, PROTOCOL_VERSION, type WorldInfo } from '@su/contracts';
import { WorldRoom } from './world-room.js';
import { readWorldDirectory } from './world-bundle.js';
import { AccountHttp } from './accounts/http.js';
import { AccountStore } from './accounts/store.js';
import { checkAccountSchema } from './accounts/migrations.js';
import type { AccountConfig } from './config.js';
import type { LoginProvider } from './accounts/telegram.js';

export interface GameServerOptions {
  port?: number;
  host?: string;
  worldDirectory?: string;
  clientDirectory?: string;
  reconnectSeconds?: number;
  prepareTimeoutMs?: number;
  accounts?: { config: AccountConfig; store: AccountStore; provider?: LoginProvider };
}
export async function createGameServer(options: GameServerOptions = {}) {
  const worldDirectory = resolve(options.worldDirectory ?? 'dist/worlds/physics-lab');
  const clientDirectory = resolve(options.clientDirectory ?? 'dist/client');
  const { manifest, definition } = await readWorldDirectory(worldDirectory);
  // worldId проверен по шаблону [a-z0-9-] и безопасен как сегмент URL.
  const worldPath = `/worlds/${manifest.worldId}`;
  if (options.accounts) await checkAccountSchema(options.accounts.store.pool);
  let room: WorldRoom | undefined;
  const accounts = options.accounts
    ? new AccountHttp(
        options.accounts.config,
        options.accounts.store,
        (id) => room?.revokeAuthSession(id),
        options.accounts.provider,
      )
    : undefined;
  const http = createServer();
  const transport = new WebSocketTransport({
    server: http,
    maxPayload: 4096,
    pingInterval: 3000,
    pingMaxRetries: 2,
    beforeUpgrade: accounts
      ? (context) => {
          const origin = context.headers.get('origin');
          if (origin && origin !== accounts.config.publicOrigin)
            return new Response('Origin is not allowed.', { status: 403 });
        }
      : undefined,
  });
  let ready = false;
  const server = new Server({
    transport,
    greet: false,
    gracefullyShutdown: false,
    express(app) {
      app.disable('x-powered-by');
      app.set('trust proxy', 'loopback');
      if (accounts) app.use(accounts.router);
      else
        app.get('/api/me', (_req, res) => {
          res.setHeader('Cache-Control', 'no-store');
          res.json({ enabled: false, account: null });
        });
      app.get('/health/live', (_req, res) => res.json({ ok: true }));
      app.get('/health/ready', async (_req, res) => {
        let available = ready;
        if (available && accounts) {
          try {
            await accounts.store.pool.query('SELECT 1');
          } catch {
            available = false;
          }
        }
        res.status(available ? 200 : 503).json({ ready: available });
      });
      app.get('/api/world', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!ready || !room) {
          res.status(503).json({ code: 'WORLD_NOT_READY' });
          return;
        }
        const info: WorldInfo = {
          roomId: room.roomId,
          worldEpoch: room.state.worldEpoch,
          protocolVersion: PROTOCOL_VERSION,
          mapVersion: manifest.mapVersion,
          simulationConfigHash: manifest.simulationConfigHash,
          manifestUrl: `${worldPath}/manifest.json`,
          maxPlayers: MAX_PLAYERS,
          available: !room.hasReachedMaxClients(),
        };
        res.json(info);
      });
      app.get('/api/diagnostics', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!ready || !room) {
          res.status(503).json({ code: 'WORLD_NOT_READY' });
          return;
        }
        res.json(room.diagnostics());
      });
      app.use(worldPath, (req, res) => {
        const file = req.path.slice(1);
        if (
          (req.method !== 'GET' && req.method !== 'HEAD') ||
          (file !== 'manifest.json' && !Object.hasOwn(manifest.files, file))
        ) {
          res.sendStatus(404);
          return;
        }
        res.setHeader(
          'Cache-Control',
          /(?:^|[/.])[a-f0-9]{64}(?:[/.]|$)/.test(file)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
        res.sendFile(resolve(worldDirectory, file));
      });
      // These routes come before the SDK matcher: arbitrary room creation is
      // deliberately absent. The sole room is created once during startup.
      app.use('/matchmake', (req, res, next) => {
        if (/^\/(joinById|reconnect)\//.test(req.path)) {
          next();
          return;
        }
        res.status(403).json({ code: 403, error: 'Only the active world may be joined.' });
      });
      app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          next();
          return;
        }
        const target = resolve(clientDirectory, req.path === '/' ? 'index.html' : `.${req.path}`);
        if (!target.startsWith(clientDirectory + sep)) {
          res.sendStatus(404);
          return;
        }
        res.sendFile(target, (error) => {
          if (error && !res.headersSent)
            res.status(404).send('Not found. For development run pnpm dev.');
        });
      });
    },
  });
  // Enforced in the matcher too, independently of HTTP middleware ordering.
  matchMaker.controller.exposedMethods = ['joinById', 'reconnect'];
  matchMaker.controller.standardHttpStatus = true;
  server.define('world', WorldRoom, {
    definition,
    manifest,
    reconnectSeconds: options.reconnectSeconds,
    prepareTimeoutMs: options.prepareTimeoutMs,
    accounts,
  });
  try {
    await server.serverless();
    const listing = await matchMaker.createRoom('world', {});
    room = matchMaker.getLocalRoomById(listing.roomId) as WorldRoom;
    ready = true;
    await new Promise<void>((resolveListen, reject) => {
      http.once('error', reject);
      http.listen(options.port ?? 2567, options.host ?? '127.0.0.1', () => {
        http.off('error', reject);
        resolveListen();
      });
    });
  } catch (error) {
    ready = false;
    await server.gracefullyShutdown(false);
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected listening address');
  let closing: Promise<void> | undefined;
  return {
    server,
    room,
    http,
    url: `http://${options.host ?? '127.0.0.1'}:${address.port}`,
    close() {
      ready = false;
      return (closing ??= server.gracefullyShutdown(false).then(
        () =>
          new Promise<void>((done) => {
            if (!http.listening) {
              done();
              return;
            }
            http.close(() => done());
            http.closeAllConnections();
          }),
      ));
    },
  };
}
