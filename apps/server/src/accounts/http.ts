import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { Router, json, type ErrorRequestHandler, type Request, type Response } from 'express';
import { parseProfileUpdate, type AccountResponse } from '@su/contracts';
import type { AccountConfig } from '../config.js';
import {
  AccountStore,
  hashToken,
  SESSION_LIFETIME_MS,
  type AuthenticatedAccount,
} from './store.js';
import {
  createTelegramLogin,
  describeTelegramFailure,
  TELEGRAM_CALLBACK,
  type LoginAttempt,
  type LoginProvider,
} from './telegram.js';

const FLOW_LIFETIME_MS = 5 * 60 * 1000;
const secret = () => randomBytes(32).toString('base64url');
const csrf = (token: string) => createHash('sha256').update(`su:csrf:${token}`).digest('base64url');
const equal = (a: string, b: string) =>
  /^[A-Za-z0-9_-]{43}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class AccountHttp {
  readonly router = Router();
  readonly sessionCookie: string;
  readonly flowCookie: string;
  private readonly flows = new Map<string, { attempt: LoginAttempt; expiresAt: number }>();
  private readonly rates = new Map<string, { count: number; until: number }>();
  private readonly provider: LoginProvider;
  private readonly revoked = new Map<string, number>();
  private readonly secure: boolean;

  constructor(
    readonly config: AccountConfig,
    readonly store: AccountStore,
    private readonly onRevoked: (sessionId: string) => void,
    provider?: LoginProvider,
  ) {
    this.provider = provider ?? createTelegramLogin(config);
    this.secure = config.publicOrigin.startsWith('https:');
    this.sessionCookie = this.secure ? '__Host-su_session' : 'su_session';
    this.flowCookie = this.secure ? '__Host-su_login' : 'su_login';
    this.router.use(['/api/auth', '/api/me'], (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    this.router.get('/api/me', async (req, res) => {
      const token = this.readToken(req.headers);
      const account = token ? await store.authenticate(token) : undefined;
      if (token && !account) this.clearCookie(res, this.sessionCookie);
      res.json(this.view(account, token));
    });
    this.router.get('/api/auth/telegram', async (req, res) => {
      if (!this.rate(req, res)) return;
      this.pruneFlows();
      if (this.flows.size >= 1000) {
        res.status(503).json({ code: 'AUTH_UNAVAILABLE' });
        return;
      }
      const { url, attempt } = await this.provider.begin();
      const flowToken = secret();
      const previous = this.readCookie(req.headers, this.flowCookie);
      if (previous) this.flows.delete(hashToken(previous));
      this.flows.set(hashToken(flowToken), { attempt, expiresAt: Date.now() + FLOW_LIFETIME_MS });
      this.setCookie(res, this.flowCookie, flowToken, FLOW_LIFETIME_MS);
      res.redirect(303, url.href);
    });
    this.router.get(TELEGRAM_CALLBACK, async (req, res) => {
      const flowToken = this.readCookie(req.headers, this.flowCookie);
      const key = flowToken ? hashToken(flowToken) : '';
      const flow = this.flows.get(key);
      this.flows.delete(key); // every callback consumes its browser-bound attempt, including failures
      this.clearCookie(res, this.flowCookie);
      if (!flow || flow.expiresAt <= Date.now()) {
        res.redirect(303, '/?login=expired');
        return;
      }
      let identity;
      try {
        const query = new URL(req.originalUrl, config.publicOrigin).search;
        identity = await this.provider.finish(
          new URL(config.publicOrigin + TELEGRAM_CALLBACK + query),
          flow.attempt,
        );
      } catch (error) {
        console.warn('Telegram login failed:', describeTelegramFailure(error));
        res.redirect(303, '/?login=failed');
        return;
      }
      const token = secret();
      try {
        const result = await store.login(identity, token, this.readToken(req.headers));
        if (result.previousSessionId) this.notifyRevoked(result.previousSessionId);
        this.setCookie(res, this.sessionCookie, token, SESSION_LIFETIME_MS);
        res.redirect(303, '/?login=success');
      } catch {
        console.error('Account creation or login could not be committed.');
        res.redirect(303, '/?login=unavailable');
      }
    });
    this.router.patch('/api/me/profile', json({ limit: '1kb' }), async (req, res) => {
      if (!this.checkCsrf(req, res) || !this.rate(req, res)) return;
      const token = this.readToken(req.headers)!;
      const account = await store.authenticate(token);
      if (!account) {
        res.status(401).json({ code: 'AUTH_REQUIRED' });
        return;
      }
      const update = parseProfileUpdate(req.body);
      if (!update) {
        res.status(400).json({ code: 'INVALID_PROFILE' });
        return;
      }
      // The authenticated account owns the target. Body account IDs are never consulted.
      const profile = await store.updateProfile(account.accountId, update);
      if (!profile) {
        const current = await store.authenticate(token);
        if (!current) {
          res.status(401).json({ code: 'AUTH_REQUIRED' });
          return;
        }
        res.status(409).json({ code: 'PROFILE_CONFLICT', profile: current.profile });
        return;
      }
      res.json({ profile });
    });
    this.router.post('/api/auth/logout', async (req, res) => {
      if (!this.checkCsrf(req, res)) return;
      const token = this.readToken(req.headers)!;
      const account = await store.authenticate(token);
      if (account) {
        await store.revokeSession(account.authSessionId);
        this.notifyRevoked(account.authSessionId);
      }
      this.clearCookie(res, this.sessionCookie);
      res.sendStatus(204);
    });
    const onError: ErrorRequestHandler = (error, _req, res, _next) => {
      if (res.headersSent) return;
      if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
        res.status(error.type === 'entity.too.large' ? 413 : 400).json({ code: 'INVALID_PROFILE' });
        return;
      }
      console.error('Account request could not reach PostgreSQL.');
      res.status(503).json({ code: 'ACCOUNTS_UNAVAILABLE' });
    };
    this.router.use(onError);
  }

  wasRevoked(sessionId: string): boolean {
    return (this.revoked.get(sessionId) ?? 0) > Date.now();
  }
  private notifyRevoked(sessionId: string): void {
    const now = Date.now();
    for (const [id, until] of this.revoked) if (until <= now) this.revoked.delete(id);
    // Covers an onAuth lookup that read the session just before logout committed.
    // Once this entry expires, every older authentication snapshot has expired too.
    this.revoked.set(sessionId, now + SESSION_LIFETIME_MS);
    this.onRevoked(sessionId);
  }
  readToken(headers: IncomingHttpHeaders | Headers): string | undefined {
    return this.readCookie(headers, this.sessionCookie);
  }
  private readCookie(headers: IncomingHttpHeaders | Headers, name: string): string | undefined {
    const header = headers instanceof Headers ? headers.get('cookie') : headers.cookie;
    const values = (header ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(name + '='));
    if (values.length !== 1) return;
    const token = values[0].slice(name.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }
  private setCookie(res: Response, name: string, value: string, maxAge: number): void {
    res.cookie(name, value, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      maxAge,
    });
  }
  private clearCookie(res: Response, name: string): void {
    res.clearCookie(name, { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/' });
  }
  private view(account?: AuthenticatedAccount, token?: string): AccountResponse {
    return {
      enabled: true,
      account: account ? { accountId: account.accountId, profile: account.profile } : null,
      ...(account && token ? { csrfToken: csrf(token) } : {}),
    };
  }
  private checkCsrf(req: Request, res: Response): boolean {
    const token = this.readToken(req.headers);
    if (!token) {
      res.status(401).json({ code: 'AUTH_REQUIRED' });
      return false;
    }
    if (
      req.get('origin') !== this.config.publicOrigin ||
      !equal(req.get('x-csrf-token') ?? '', csrf(token))
    ) {
      res.status(403).json({ code: 'INVALID_ORIGIN' });
      return false;
    }
    return true;
  }
  private rate(req: Request, res: Response): boolean {
    const now = Date.now();
    for (const [key, value] of this.rates) if (value.until <= now) this.rates.delete(key);
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let entry = this.rates.get(key);
    if (!entry) {
      if (this.rates.size >= 1000) {
        res.status(429).json({ code: 'RATE_LIMITED' });
        return false;
      }
      entry = { count: 0, until: now + 60000 };
      this.rates.set(key, entry);
    }
    if (++entry.count <= 30) return true;
    res.setHeader('Retry-After', Math.ceil((entry.until - now) / 1000));
    res.status(429).json({ code: 'RATE_LIMITED' });
    return false;
  }
  private pruneFlows(): void {
    const now = Date.now();
    for (const [key, value] of this.flows) if (value.expiresAt <= now) this.flows.delete(key);
  }
}
