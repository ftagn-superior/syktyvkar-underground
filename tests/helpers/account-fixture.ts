import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import * as oidc from 'openid-client';
import { AccountStore } from '../../apps/server/src/accounts/store.js';
import { createDatabasePool } from '../../apps/server/src/database.js';
import { migrateDatabase } from '../../apps/server/src/migrations.js';
import { createTelegramLogin } from '../../apps/server/src/accounts/telegram.js';
import type { AccountConfig } from '../../apps/server/src/config.js';

/** Real SQL and real OIDC signatures; all test writes stay in a newly-created private schema. */
export async function createAccountFixture(databaseUrl: string) {
  const schema = 'su_test_' + randomBytes(12).toString('hex');
  const admin = createDatabasePool(databaseUrl);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createDatabasePool(databaseUrl, { options: `-c search_path=${schema}` });
  pool.on('error', () => {});
  const keys = await generateKeyPair('RS256');
  const wrongKeys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { nonce: string; challenge: string; subject: string; failure: string | null }
  >();
  let issuer = '';
  const providerServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, issuer);
      if (url.pathname === '/jwks') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (url.pathname === '/authorize') {
        assert.equal(url.searchParams.get('scope'), 'openid');
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        const code = randomBytes(24).toString('hex');
        codes.set(code, {
          nonce: url.searchParams.get('nonce')!,
          challenge: url.searchParams.get('code_challenge')!,
          subject: url.searchParams.get('test_subject') ?? 'browser-player',
          failure: url.searchParams.get('test_failure'),
        });
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        callback.searchParams.set('code', code);
        res.writeHead(303, { Location: callback.href });
        res.end();
        return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parameters = new URLSearchParams(body);
        assert.equal(req.headers.authorization, undefined);
        assert.equal(parameters.get('client_secret'), 'test-secret');
        // Telegram's documented token request includes client_id in the body even with Basic auth.
        if (parameters.get('client_id') !== 'test-client') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_client' }));
          return;
        }
        const code = parameters.get('code')!;
        const entry = codes.get(code);
        codes.delete(code);
        if (
          !entry ||
          entry.challenge !==
            createHash('sha256')
              .update(parameters.get('code_verifier') ?? '')
              .digest('base64url')
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const idToken = await new SignJWT({
          nonce: entry.failure === 'nonce' ? 'wrong' : entry.nonce,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer(issuer)
          .setAudience(entry.failure === 'audience' ? 'wrong-client' : 'test-client')
          .setSubject(entry.subject)
          .setIssuedAt()
          .setExpirationTime(
            entry.failure === 'expired' ? Math.floor(Date.now() / 1000) - 60 : '5m',
          )
          .sign(entry.failure === 'signature' ? wrongKeys.privateKey : keys.privateKey);
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            access_token: 'unused-test-access-token',
            token_type: 'Bearer',
            expires_in: 300,
            id_token: idToken,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (error) {
      console.error('Local OIDC fixture failed:', (error as Error).message);
      res.writeHead(500);
      res.end('Test OIDC provider failed');
    }
  });
  try {
    assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
    await migrateDatabase(pool);
    await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
    const address = providerServer.address();
    assert(address && typeof address !== 'string');
    issuer = `http://127.0.0.1:${address.port}`;
    const config: AccountConfig = {
      publicOrigin: 'http://127.0.0.1',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      databaseUrl,
    };
    const oidcConfig = new oidc.Configuration(
      {
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks',
        id_token_signing_alg_values_supported: ['RS256'],
      },
      config.clientId,
      { id_token_signed_response_alg: 'RS256' },
      oidc.ClientSecretPost(config.clientSecret),
    );
    oidc.allowInsecureRequests(oidcConfig);
    return {
      schema,
      pool,
      config,
      store: new AccountStore(pool),
      provider: createTelegramLogin(config, oidcConfig),
      async close() {
        await new Promise<void>((resolve, reject) =>
          providerServer.close((error) => (error ? reject(error) : resolve())),
        );
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      },
    };
  } catch (error) {
    providerServer.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    throw error;
  }
}

export function responseCookie(response: Response, name: string): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(name + '='));
  assert(cookie, `Missing ${name} cookie`);
  return cookie.split(';')[0];
}

export async function loginAccount(base: string, subject: string, failure?: string) {
  const start = await fetch(base + '/api/auth/telegram', { redirect: 'manual' });
  assert.equal(start.status, 303);
  const flowCookie = responseCookie(start, 'su_login');
  const authUrl = new URL(start.headers.get('location')!);
  authUrl.searchParams.set('test_subject', subject);
  if (failure) authUrl.searchParams.set('test_failure', failure);
  const authorized = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(authorized.status, 303);
  const callback = authorized.headers.get('location')!;
  const result = await fetch(callback, { headers: { Cookie: flowCookie }, redirect: 'manual' });
  return { result, callback, flowCookie };
}
