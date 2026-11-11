import { describe, it, expect, vi } from 'vitest';
import { createTelegramLogin, describeTelegramFailure } from './telegram.js';

describe('safe Telegram failure diagnostics', () => {
  it('sends the client ID and exact secret as form fields, including reserved characters', async () => {
    const clientSecret = 'test.secret-with_reserved~+/=';
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      const provider = createTelegramLogin({
        publicOrigin: 'https://example.test',
        clientId: 'test-client',
        clientSecret,
        databaseUrl: 'postgresql://unused',
      });
      const { attempt } = await provider.begin();
      const callback = new URL('https://example.test/api/auth/telegram/callback');
      callback.searchParams.set('code', 'test-code');
      callback.searchParams.set('state', attempt.state);
      await expect(provider.finish(callback, attempt)).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
      const init = request.mock.calls[0][1];
      const form = new URLSearchParams(init?.body as URLSearchParams);
      expect(form.get('client_id')).toBe('test-client');
      expect(form.get('client_secret')).toBe(clientSecret);
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
    } finally {
      request.mockRestore();
    }
  });
  it('reports the failing claim without logging tokens, claim values or provider text', () => {
    const error = Object.assign(new Error('private response and credentials'), {
      code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
      cause: {
        claim: 'nonce',
        expected: 'private-nonce',
        claims: { sub: 'private-user', nonce: 'private-token' },
        body: {
          error: 'invalid_grant',
          error_description: 'private provider message',
          id_token: 'private-jwt',
        },
      },
    });
    expect(describeTelegramFailure(error)).toEqual({
      code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
      claim: 'nonce',
      oauthError: 'invalid_grant',
    });
    expect(JSON.stringify(describeTelegramFailure(error))).not.toContain('private');
  });
  it('reports a nested network failure and HTTP status using only allowlisted metadata', () => {
    expect(
      describeTelegramFailure({
        message: 'private URL',
        cause: { status: 502, cause: { code: 'EAI_AGAIN' } },
      }),
    ).toEqual({ code: 'UNKNOWN', status: 502, networkCode: 'EAI_AGAIN' });
    expect(
      describeTelegramFailure({
        code: 'private-secret',
        error: 'private-secret',
        claim: 'private-secret',
      }),
    ).toEqual({ code: 'UNKNOWN' });
  });
});
