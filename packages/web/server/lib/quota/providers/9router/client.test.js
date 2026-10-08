import { describe, expect, it } from 'vitest';
import { createNineRouterClient } from './client.js';

const SERVER = { name: 'vps', url: 'https://router.test', password: 'pw-secret' };
const cookieResponse = () => new Response(JSON.stringify({ success: true }), {
  status: 200,
  headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'auth_token=tok-secret; Path=/; HttpOnly' },
});
const listResponse = (connections) => Response.json({ connections, pagination: { page: 1, total: connections.length } });
const codexUsage = (used) => Response.json({ quotas: { session: { used, total: 100, remaining: 100 - used, resetAt: null, unlimited: false } } });

const makeFetch = (routes) => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const { pathname, search } = new URL(url);
    calls.push({ path: pathname + search, method: options.method ?? 'GET', cookie: new Headers(options.headers).get('Cookie'), body: options.body });
    const handler = routes[pathname] ?? routes[pathname.replace(/[^/]+$/, ':id')];
    if (!handler) throw new Error(`unexpected ${pathname}`);
    return handler({ pathname, options, calls });
  };
  return { fetchImpl, calls };
};

describe('9Router client', () => {
  it('logs in once, lists active connections and aggregates their windows', async () => {
    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => listResponse([
        { id: 'a', provider: 'codex', isActive: true },
        { id: 'b', provider: 'codex', isActive: false },
        { id: 'c', provider: 'codex' },
      ]),
      '/api/usage/:id': ({ pathname }) => codexUsage(pathname.endsWith('/a') ? 20 : 60),
    });
    const client = createNineRouterClient({ fetchImpl });
    const result = await client.fetchServer(SERVER);
    expect(result.skipped).toBe(0);
    expect(result.connections).toEqual([
      { provider: 'codex', windows: [{ windowKey: 'session', usedPercent: 20, resetAt: null }] },
      { provider: 'codex', windows: [{ windowKey: 'session', usedPercent: 60, resetAt: null }] },
    ]);
    expect(calls[0]).toMatchObject({ path: '/api/auth/login', method: 'POST', body: JSON.stringify({ password: 'pw-secret' }) });
    expect(calls[1].path).toBe('/api/providers/client?provider=all&accountStatus=active&page=1&pageSize=500');
    expect(calls.slice(1).every((call) => call.cookie === 'auth_token=tok-secret')).toBe(true);
    expect(calls.filter((call) => call.path.startsWith('/api/usage/')).map((c) => c.path)).toEqual(['/api/usage/a', '/api/usage/c']);
    expect(JSON.stringify(result)).not.toMatch(/secret/);

    await client.fetchServer(SERVER);
    expect(calls.filter((call) => call.path === '/api/auth/login')).toHaveLength(1);
  });

  it('does not log in again after a wrong password', async () => {
    const { fetchImpl, calls } = makeFetch({ '/api/auth/login': () => Response.json({ error: 'Invalid password', remainingBeforeLock: 4 }, { status: 401 }) });
    const client = createNineRouterClient({ fetchImpl });
    await expect(client.fetchServer(SERVER)).rejects.toThrow('wrong dashboard password');
    await expect(client.fetchServer(SERVER)).rejects.toThrow('wrong dashboard password');
    expect(calls).toHaveLength(1);
  });

  it('logs in again once the password changes', async () => {
    let attempt = 0;
    const { fetchImpl } = makeFetch({
      '/api/auth/login': () => (++attempt === 1 ? Response.json({ error: 'x' }, { status: 401 }) : cookieResponse()),
      '/api/providers/client': () => listResponse([]),
    });
    const client = createNineRouterClient({ fetchImpl });
    await expect(client.fetchServer(SERVER)).rejects.toThrow('wrong dashboard password');
    await expect(client.fetchServer({ ...SERVER, password: 'new-pw' })).resolves.toEqual({ connections: [], skipped: 0 });
  });

  it('waits out a lockout before calling again', async () => {
    let time = 1_000_000;
    let attempt = 0;
    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => (++attempt === 1
        ? new Response(JSON.stringify({ error: 'locked', retryAfter: 30 }), { status: 429, headers: { 'Retry-After': '30' } })
        : cookieResponse()),
      '/api/providers/client': () => listResponse([]),
    });
    const client = createNineRouterClient({ fetchImpl, now: () => time });
    await expect(client.fetchServer(SERVER)).rejects.toThrow('dashboard login locked, retry in 30 s');
    time += 29_000;
    await expect(client.fetchServer(SERVER)).rejects.toThrow('dashboard login locked, retry in 1 s');
    expect(calls).toHaveLength(1);
    time += 1_000;
    await expect(client.fetchServer(SERVER)).resolves.toEqual({ connections: [], skipped: 0 });
  });

  it('re-logs in once when the session is rejected', async () => {
    let list = 0;
    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => (++list === 1 ? Response.json({ error: 'Unauthorized' }, { status: 401 }) : listResponse([])),
    });
    const client = createNineRouterClient({ fetchImpl });
    await expect(client.fetchServer(SERVER)).resolves.toEqual({ connections: [], skipped: 0 });
    expect(calls.map((c) => c.path.split('?')[0])).toEqual(['/api/auth/login', '/api/providers/client', '/api/auth/login', '/api/providers/client']);
  });

  it('skips connections whose usage cannot be read', async () => {
    const { fetchImpl } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => listResponse(['ok', 'refresh', 'gone', 'boom', 'message', 'badjson', 'net'].map((id) => ({ id, provider: 'codex' }))),
      '/api/usage/:id': ({ pathname }) => {
        const id = pathname.split('/').pop();
        if (id === 'ok') return codexUsage(10);
        if (id === 'refresh') return Response.json({ error: 'Credential refresh failed: x' }, { status: 401 });
        if (id === 'gone') return Response.json({ error: 'Connection not found' }, { status: 404 });
        if (id === 'boom') return new Response('fail', { status: 500 });
        if (id === 'message') return Response.json({ message: 'Usage not available for this connection' });
        if (id === 'badjson') return new Response('{not json', { status: 200 });
        throw new TypeError('fetch failed');
      },
    });
    const result = await createNineRouterClient({ fetchImpl }).fetchServer(SERVER);
    expect(result.connections).toHaveLength(1);
    expect(result.skipped).toBe(6);
  });

  it('caches a server result for 60 seconds and shares in-flight requests', async () => {
    let time = 0;
    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => listResponse([]),
    });
    const client = createNineRouterClient({ fetchImpl, now: () => time });
    await Promise.all([client.fetchServerCached(SERVER), client.fetchServerCached(SERVER)]);
    time += 59_000;
    await client.fetchServerCached(SERVER);
    expect(calls.filter((c) => c.path.startsWith('/api/providers/client'))).toHaveLength(1);
    time += 2_000;
    await client.fetchServerCached(SERVER);
    expect(calls.filter((c) => c.path.startsWith('/api/providers/client'))).toHaveLength(2);
  });

  it('reports timeouts and list failures without leaking secrets', async () => {
    const timeout = makeFetch({ '/api/auth/login': () => { throw new DOMException('timed out', 'TimeoutError'); } });
    await expect(createNineRouterClient({ fetchImpl: timeout.fetchImpl }).fetchServer(SERVER)).rejects.toThrow('request timed out');
    const failing = makeFetch({ '/api/auth/login': () => cookieResponse(), '/api/providers/client': () => new Response('x', { status: 502 }) });
    const error = await createNineRouterClient({ fetchImpl: failing.fetchImpl }).fetchServer(SERVER).catch((e) => e);
    expect(error.message).toBe('connection list failed (HTTP 502)');
    expect(error.message).not.toMatch(/secret/);
  });

  it('checkLogin performs a fresh login and surfaces 9Router rejections', async () => {
    const { fetchImpl, calls } = makeFetch({ '/api/auth/login': () => Response.json({ error: 'Password login disabled: SSO configured' }, { status: 403 }) });
    const client = createNineRouterClient({ fetchImpl });
    await expect(client.checkLogin(SERVER)).rejects.toThrow('dashboard login rejected: Password login disabled: SSO configured');
    await expect(client.checkLogin(SERVER)).rejects.toThrow('dashboard login rejected');
    expect(calls).toHaveLength(2);
  });

  it('caps 9Router login error text at 200 characters with ellipsis', async () => {
    const longError = 'E'.repeat(250);
    const expected = `dashboard login rejected: ${'E'.repeat(200)}…`;
    const { fetchImpl } = makeFetch({ '/api/auth/login': () => Response.json({ error: longError }, { status: 403 }) });
    const client = createNineRouterClient({ fetchImpl });
    await expect(client.checkLogin(SERVER)).rejects.toThrow(expected);
  });

  it('login 503 is not remembered and logs in again on next fetchServer', async () => {
    let attempt = 0;
    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => (++attempt === 1
        ? new Response('Service Unavailable', { status: 503 })
        : cookieResponse()),
      '/api/providers/client': () => listResponse([]),
    });
    const client = createNineRouterClient({ fetchImpl });
    await expect(client.fetchServer(SERVER)).rejects.toThrow('dashboard login failed (HTTP 503)');
    expect(calls.filter((c) => c.path === '/api/auth/login')).toHaveLength(1);
    await expect(client.fetchServer(SERVER)).resolves.toEqual({ connections: [], skipped: 0 });
    expect(calls.filter((c) => c.path === '/api/auth/login')).toHaveLength(2);
  });

  it('wrong password then checkLogin succeeds clears cached rejection and makes fresh list call', async () => {
    let loginAttempt = 0;
    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => (++loginAttempt === 1
        ? Response.json({ error: 'Invalid password' }, { status: 401 })
        : cookieResponse()),
      '/api/providers/client': () => listResponse([]),
    });
    const client = createNineRouterClient({ fetchImpl });
    await expect(client.fetchServerCached(SERVER)).rejects.toThrow('wrong dashboard password');
    expect(calls).toHaveLength(1);

    await expect(client.checkLogin(SERVER)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);

    await expect(client.fetchServerCached(SERVER)).resolves.toEqual({ connections: [], skipped: 0 });
    expect(calls).toHaveLength(3);
    expect(calls[2].path).toBe('/api/providers/client?provider=all&accountStatus=active&page=1&pageSize=500');
  });

  it('checkLogin during an active lockout makes no network call', async () => {
    let time = 1_000_000;
    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => new Response(JSON.stringify({ error: 'locked', retryAfter: 30 }), {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    });
    const client = createNineRouterClient({ fetchImpl, now: () => time });
    await expect(client.fetchServer(SERVER)).rejects.toThrow('dashboard login locked, retry in 30 s');
    expect(calls).toHaveLength(1);

    time += 10_000;
    await expect(client.checkLogin(SERVER)).rejects.toThrow('dashboard login locked, retry in 20 s');
    expect(calls).toHaveLength(1);
  });

  it('two concurrent fetchServer calls with no session make exactly one login POST', async () => {
    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => listResponse([]),
    });
    const client = createNineRouterClient({ fetchImpl });
    const [res1, res2] = await Promise.all([client.fetchServer(SERVER), client.fetchServer(SERVER)]);
    expect(res1).toEqual({ connections: [], skipped: 0 });
    expect(res2).toEqual({ connections: [], skipped: 0 });
    expect(calls.filter((c) => c.path === '/api/auth/login')).toHaveLength(1);
    expect(calls.filter((c) => c.path.startsWith('/api/providers/client'))).toHaveLength(2);
  });

  it('fetchServerCached caches a rejection and makes no network call within 60 s', async () => {
    let time = 0;
    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => new Response('Bad Gateway', { status: 502 }),
    });
    const client = createNineRouterClient({ fetchImpl, now: () => time });
    await expect(client.fetchServerCached(SERVER)).rejects.toThrow('connection list failed (HTTP 502)');
    expect(calls).toHaveLength(2);

    time += 30_000;
    await expect(client.fetchServerCached(SERVER)).rejects.toThrow('connection list failed (HTTP 502)');
    expect(calls).toHaveLength(2);

    time += 31_000;
    await expect(client.fetchServerCached(SERVER)).rejects.toThrow('connection list failed (HTTP 502)');
    expect(calls).toHaveLength(3);
  });

  it('usage requests never exceed 4 in flight', async () => {
    let currentInFlight = 0;
    let maxInFlight = 0;
    const connections = Array.from({ length: 10 }, (_, i) => ({ id: `conn-${i}`, provider: 'codex' }));

    const { fetchImpl } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => listResponse(connections),
      '/api/usage/:id': async () => {
        currentInFlight++;
        maxInFlight = Math.max(maxInFlight, currentInFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentInFlight--;
        return codexUsage(20);
      },
    });

    const client = createNineRouterClient({ fetchImpl });
    const result = await client.fetchServer(SERVER);
    expect(result.connections).toHaveLength(10);
    expect(result.skipped).toBe(0);
    expect(maxInFlight).toBe(4);
  });

  it('3xx list response triggers exactly one re-login', async () => {
    let listCount = 0;
    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => (++listCount === 1
        ? new Response(null, { status: 302, headers: { Location: '/login' } })
        : listResponse([])),
    });
    const client = createNineRouterClient({ fetchImpl });
    await expect(client.fetchServer(SERVER)).resolves.toEqual({ connections: [], skipped: 0 });
    expect(calls.map((c) => c.path.split('?')[0])).toEqual([
      '/api/auth/login',
      '/api/providers/client',
      '/api/auth/login',
      '/api/providers/client',
    ]);
  });

  it('blank Retry-After header falls back to 60 s lockout', async () => {
    const { fetchImpl } = makeFetch({
      '/api/auth/login': () => new Response(JSON.stringify({ error: 'locked' }), {
        status: 429,
        headers: { 'Retry-After': '   ' },
      }),
    });
    const client = createNineRouterClient({ fetchImpl });
    await expect(client.fetchServer(SERVER)).rejects.toThrow('dashboard login locked, retry in 60 s');
  });

  it('timeout while reading response body surfaces as request timed out', async () => {
    const timeoutResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new DOMException('timed out', 'TimeoutError'));
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const { fetchImpl } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => timeoutResponse,
    });
    const client = createNineRouterClient({ fetchImpl });
    await expect(client.fetchServer(SERVER)).rejects.toThrow('request timed out');
  });
});
