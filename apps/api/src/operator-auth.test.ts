import { describe, expect, it } from 'vitest';
import { LocalOperatorAuthenticator } from './operator-auth.js';

const ORIGIN = 'http://127.0.0.1:5173';
const SECRET = 'A'.repeat(43);
const BASE_TIME = new Date('2026-09-24T12:00:00.000Z');

function auth(secret: string | undefined = SECRET) {
  let now = new Date(BASE_TIME);
  const instance = new LocalOperatorAuthenticator({ secret, allowedOrigin: ORIGIN, clock: () => now });
  return { instance, advance(ms: number) { now = new Date(now.getTime() + ms); } };
}
function login(instance: LocalOperatorAuthenticator, password = SECRET) {
  return instance.login({ password, origin: ORIGIN, hostname: '127.0.0.1', remoteAddress: '127.0.0.1' });
}

describe('local operator authentication', () => {
  it('fails closed without a configured external credential and rejects invalid origins', () => {
    const { instance } = auth('');
    expect(instance.configured).toBe(false);
    expect(instance.authorizeMutation({ cookieHeader: undefined, origin: ORIGIN, hostname: '127.0.0.1', remoteAddress: '127.0.0.1' }))
      .toMatchObject({ ok: false, statusCode: 503, error: 'OPERATOR_AUTH_UNAVAILABLE' });
    expect(instance.login({ password: SECRET, origin: 'http://attacker.invalid', hostname: '127.0.0.1', remoteAddress: '127.0.0.1' }))
      .toMatchObject({ ok: false, statusCode: 403 });
    expect(() => new LocalOperatorAuthenticator({ secret: SECRET, allowedOrigin: 'https://example.com' }))
      .toThrow('OPERATOR_ORIGIN_INVALID');
  });

  it('uses a server-derived identity, strict local origin checks, and an HttpOnly SameSite cookie', () => {
    const { instance } = auth();
    const result = login(instance);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.operatorId).toMatch(/^local-[0-9a-f]{16}$/u);
    expect(result.cookie).toContain('HttpOnly');
    expect(result.cookie).toContain('SameSite=Strict');
    expect(result.cookie).not.toContain(SECRET);
    const context = { cookieHeader: result.cookie.split(';')[0], origin: ORIGIN, hostname: 'localhost', remoteAddress: '127.0.0.1' };
    expect(instance.authorizeMutation(context)).toMatchObject({ ok: true, principal: { operatorId: result.principal.operatorId } });
    expect(instance.authorizeMutation({ ...context, origin: 'http://localhost:5173' }))
      .toMatchObject({ ok: false, statusCode: 403 });
    expect(instance.authorizeMutation({ ...context, hostname: '192.168.1.2' }))
      .toMatchObject({ ok: false, statusCode: 403 });
    expect(instance.authorizeRead({ ...context, origin: undefined })).toMatchObject({ ok: true });
    expect(instance.logout(context)).toMatchObject({ ok: true });
    expect(instance.authorizeMutation(context)).toMatchObject({ ok: false, statusCode: 401 });
    expect(instance.clearCookieHeader).toContain('Max-Age=0');
  });

  it('expires sessions and rate-limits repeated invalid credentials', () => {
    const { instance, advance } = auth();
    const accepted = login(instance);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      advance(8 * 60 * 60 * 1000);
      expect(instance.authorizeRead({ cookieHeader: accepted.cookie.split(';')[0], origin: ORIGIN,
        hostname: '127.0.0.1', remoteAddress: '127.0.0.1' })).toMatchObject({ ok: false, statusCode: 401 });
    }
    for (let attempt = 0; attempt < 8; attempt += 1) expect(login(instance, 'B'.repeat(43))).toMatchObject({ ok: false, statusCode: 401 });
    expect(login(instance, 'B'.repeat(43))).toMatchObject({ ok: false, statusCode: 429 });
  });
});