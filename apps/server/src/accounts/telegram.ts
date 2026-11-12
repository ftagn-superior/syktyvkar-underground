import * as oidc from 'openid-client';
import type { AccountConfig } from '../config.js';
import type { Identity } from './store.js';

export interface LoginAttempt {
  state: string;
  nonce: string;
  verifier: string;
}
export interface LoginProvider {
  begin(): Promise<{ url: URL; attempt: LoginAttempt }>;
  finish(url: URL, attempt: LoginAttempt): Promise<Identity>;
}
export const TELEGRAM_CALLBACK = '/api/auth/telegram/callback';

/** Only protocol codes and field names are safe to log; errors can contain entire tokens. */
export function describeTelegramFailure(error: unknown): Record<string, string | number> {
  const result: Record<string, string | number> = { code: 'UNKNOWN' };
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const oauthErrors = new Set([
    'invalid_request',
    'invalid_client',
    'invalid_grant',
    'unauthorized_client',
    'unsupported_grant_type',
    'invalid_scope',
    'access_denied',
    'server_error',
    'temporarily_unavailable',
  ]);
  const claims = new Set([
    'iss',
    'aud',
    'sub',
    'exp',
    'iat',
    'nbf',
    'nonce',
    'state',
    'alg',
    'kid',
    'access_token',
    'id_token',
    'token_type',
    'expires_in',
  ]);
  for (let item = record(error), depth = 0; item && depth < 4; item = record(item.cause), depth++) {
    if (typeof item.code === 'string') {
      if (
        /^(?:OAUTH_|ERR_JWT_|ERR_JWS_|ERR_JOSE_)[A-Z_]+$/.test(item.code) &&
        result.code === 'UNKNOWN'
      )
        result.code = item.code;
      if (
        [
          'ENOTFOUND',
          'EAI_AGAIN',
          'ECONNRESET',
          'ECONNREFUSED',
          'ETIMEDOUT',
          'UND_ERR_CONNECT_TIMEOUT',
        ].includes(item.code)
      )
        result.networkCode = item.code;
    }
    if (typeof item.claim === 'string' && claims.has(item.claim)) result.claim = item.claim;
    const response = record(item.response);
    const status = item.status ?? response?.status;
    if (typeof status === 'number' && status >= 100 && status <= 599) result.status = status;
    const providerError = item.error ?? record(item.body)?.error;
    if (typeof providerError === 'string' && oauthErrors.has(providerError))
      result.oauthError = providerError;
  }
  return result;
}

export function createTelegramLogin(
  config: AccountConfig,
  configuration?: oidc.Configuration,
): LoginProvider {
  const client =
    configuration ??
    new oidc.Configuration(
      {
        issuer: 'https://oauth.telegram.org',
        authorization_endpoint: 'https://oauth.telegram.org/auth',
        token_endpoint: 'https://oauth.telegram.org/token',
        jwks_uri: 'https://oauth.telegram.org/.well-known/jwks.json',
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      },
      config.clientId,
      { id_token_signed_response_alg: 'RS256' },
      oidc.ClientSecretPost(config.clientSecret),
    );
  client.timeout = 8;
  // Code-flow ID tokens also get cryptographic signature verification via Telegram's JWKS.
  oidc.enableNonRepudiationChecks(client);
  return {
    async begin() {
      const attempt = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        verifier: oidc.randomPKCECodeVerifier(),
      };
      const url = oidc.buildAuthorizationUrl(client, {
        redirect_uri: config.publicOrigin + TELEGRAM_CALLBACK,
        scope: 'openid',
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(attempt.verifier),
        code_challenge_method: 'S256',
      });
      return { url, attempt };
    },
    async finish(url, attempt) {
      const tokens = await oidc.authorizationCodeGrant(
        client,
        url,
        {
          expectedState: attempt.state,
          expectedNonce: attempt.nonce,
          pkceCodeVerifier: attempt.verifier,
          idTokenExpected: true,
        },
        { client_id: config.clientId },
      );
      const claims = tokens.claims();
      if (!claims?.sub || !claims.iss) throw new Error('Missing OIDC identity.');
      return { issuer: claims.iss, subject: claims.sub };
    },
  };
}
