import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'ered_luin_operator';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 8;
const SESSION_LIMIT = 8;

export interface OperatorPrincipal {
  readonly operatorId: string;
  readonly expiresAt: string;
}
export interface OperatorRequestContext {
  readonly cookieHeader: string | undefined;
  readonly origin: string | undefined;
  readonly hostname: string;
  readonly remoteAddress: string | undefined;
}
export type OperatorAuthorization =
  | { readonly ok: true; readonly principal: OperatorPrincipal }
  | { readonly ok: false; readonly statusCode: 401 | 403 | 429 | 503; readonly error: string };
export type OperatorLoginResult =
  | { readonly ok: true; readonly cookie: string; readonly principal: OperatorPrincipal }
  | { readonly ok: false; readonly statusCode: 400 | 401 | 403 | 429 | 503; readonly error: string };

function isLoopbackHost(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[([^\]]+)\](?::\d+)?$/u, '$1').replace(/:\d+$/u, '');
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}
function digest(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }
function cookieValue(header: string | undefined): string | null {
  if (!header || header.length > 4096) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
    }
  }
  return null;
}

export class LocalOperatorAuthenticator {
  private readonly expectedDigest: Buffer | null;
  private readonly operatorId: string | null;
  private readonly allowedOrigin: string;
  private readonly secureCookie: boolean;
  private readonly clock: () => Date;
  private readonly sessions = new Map<string, OperatorPrincipal>();
  private readonly failures = new Map<string, { count: number; startedAt: number }>();

  constructor(input: { readonly secret?: string; readonly allowedOrigin: string; readonly clock?: () => Date }) {
    let origin: URL;
    try { origin = new URL(input.allowedOrigin); }
    catch { throw new Error('OPERATOR_ORIGIN_INVALID'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== input.allowedOrigin ||
        origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !isLoopbackHost(origin.hostname)) {
      throw new Error('OPERATOR_ORIGIN_INVALID');
    }
    this.allowedOrigin = origin.origin;
    this.secureCookie = origin.protocol === 'https:';
    this.clock = input.clock ?? (() => new Date());
    const secret = input.secret;
    if (secret !== undefined && secret !== '' && !/^[A-Za-z0-9_-]{43,128}$/u.test(secret)) {
      throw new Error('OPERATOR_SECRET_INVALID');
    }
    this.expectedDigest = secret ? digest(secret) : null;
    this.operatorId = this.expectedDigest ? 'local-' + this.expectedDigest.toString('hex').slice(0, 16) : null;
  }

  get configured(): boolean { return this.expectedDigest !== null; }
  get clearCookieHeader(): string {
    return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (this.secureCookie ? '; Secure' : '');
  }

  inspect(cookieHeader: string | undefined): { readonly configured: boolean; readonly authenticated: boolean; readonly expiresAt: string | null } {
    const principal = this.session(cookieHeader);
    return { configured: this.configured, authenticated: principal !== null, expiresAt: principal?.expiresAt ?? null };
  }

  login(input: { readonly password: string; readonly origin: string | undefined; readonly hostname: string; readonly remoteAddress: string | undefined }): OperatorLoginResult {
    if (!isLoopbackHost(input.hostname) || input.origin !== this.allowedOrigin) {
      return { ok: false, statusCode: 403, error: 'OPERATOR_ORIGIN_REJECTED' };
    }
    if (!this.expectedDigest || !this.operatorId) return { ok: false, statusCode: 503, error: 'OPERATOR_AUTH_UNAVAILABLE' };
    const now = this.nowMs();
    const address = input.remoteAddress ?? 'local-unknown';
    const previous = this.failures.get(address);
    const attempts = previous && now - previous.startedAt < LOGIN_WINDOW_MS ? previous : { count: 0, startedAt: now };
    if (attempts.count >= LOGIN_ATTEMPT_LIMIT) return { ok: false, statusCode: 429, error: 'OPERATOR_LOGIN_RATE_LIMITED' };
    const supplied = digest(input.password);
    if (!timingSafeEqual(supplied, this.expectedDigest)) {
      this.failures.set(address, { count: attempts.count + 1, startedAt: attempts.startedAt });
      return { ok: false, statusCode: 401, error: 'OPERATOR_CREDENTIAL_INVALID' };
    }
    this.failures.delete(address);
    const nowMsForCleanup = this.nowMs();
    for (const [tokenValue, item] of this.sessions) {
      if (Date.parse(item.expiresAt) <= nowMsForCleanup) this.sessions.delete(tokenValue);
    }
    if (this.sessions.size >= SESSION_LIMIT) return { ok: false, statusCode: 429, error: 'OPERATOR_SESSION_LIMIT' };
    const token = randomBytes(32).toString('base64url');
    const principal = Object.freeze({ operatorId: this.operatorId, expiresAt: new Date(now + SESSION_TTL_MS).toISOString() });
    this.sessions.set(token, principal);
    const cookie = COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + (this.secureCookie ? '; Secure' : '');
    return { ok: true, cookie, principal };
  }

  authorizeRead(context: OperatorRequestContext): OperatorAuthorization {
    if (!isLoopbackHost(context.hostname) || context.origin !== undefined && context.origin !== this.allowedOrigin) {
      return { ok: false, statusCode: 403, error: 'OPERATOR_ORIGIN_REJECTED' };
    }
    if (!this.configured) return { ok: false, statusCode: 503, error: 'OPERATOR_AUTH_UNAVAILABLE' };
    const principal = this.session(context.cookieHeader);
    if (!principal) return { ok: false, statusCode: 401, error: 'OPERATOR_AUTH_REQUIRED' };
    return { ok: true, principal };
  }

  authorizeMutation(context: OperatorRequestContext): OperatorAuthorization {
    if (!isLoopbackHost(context.hostname) || context.origin !== this.allowedOrigin) {
      return { ok: false, statusCode: 403, error: 'OPERATOR_ORIGIN_REJECTED' };
    }
    if (!this.configured) return { ok: false, statusCode: 503, error: 'OPERATOR_AUTH_UNAVAILABLE' };
    const principal = this.session(context.cookieHeader);
    if (!principal) return { ok: false, statusCode: 401, error: 'OPERATOR_AUTH_REQUIRED' };
    return { ok: true, principal };
  }

  logout(context: OperatorRequestContext): OperatorAuthorization {
    const authorization = this.authorizeMutation(context);
    if (!authorization.ok) return authorization;
    const token = cookieValue(context.cookieHeader);
    if (token) this.sessions.delete(token);
    return authorization;
  }

  private session(cookieHeader: string | undefined): OperatorPrincipal | null {
    const token = cookieValue(cookieHeader);
    if (!token) return null;
    const principal = this.sessions.get(token);
    if (!principal) return null;
    if (Date.parse(principal.expiresAt) <= this.nowMs()) {
      this.sessions.delete(token);
      return null;
    }
    return principal;
  }

  private nowMs(): number {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() < 0) throw new Error('OPERATOR_CLOCK_INVALID');
    return value.getTime();
  }
}
