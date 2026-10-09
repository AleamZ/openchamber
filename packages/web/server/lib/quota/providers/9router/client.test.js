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
      { provider: 'codex', windows: [{ windowKey: 'session', kind: 'percent', usedPercent: 20, resetAt: null }] },
      { provider: 'codex', windows: [{ windowKey: 'session', kind: 'percent', usedPercent: 60, resetAt: null }] },
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
    await expect(client.fetchServer({ ...SERVER, password: 'new-pw' })).resolves.toEqual({ connections: [], skipped: 0, skippedReasons: {}, pending: 0 });
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
    await expect(client.fetchServer(SERVER)).resolves.toEqual({ connections: [], skipped: 0, skippedReasons: {}, pending: 0 });
  });

  it('re-logs in once when the session is rejected', async () => {
    let list = 0;
    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => (++list === 1 ? Response.json({ error: 'Unauthorized' }, { status: 401 }) : listResponse([])),
    });
    const client = createNineRouterClient({ fetchImpl });
    await expect(client.fetchServer(SERVER)).resolves.toEqual({ connections: [], skipped: 0, skippedReasons: {}, pending: 0 });
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
    expect(result.skippedReasons).toEqual({
      'HTTP 401': 1,
      'HTTP 404': 1,
      'HTTP 500': 1,
      'no usage data': 1,
      'invalid response': 1,
      error: 1,
    });
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
    await expect(client.fetchServer(SERVER)).resolves.toEqual({ connections: [], skipped: 0, skippedReasons: {}, pending: 0 });
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

    await expect(client.fetchServerCached(SERVER)).resolves.toEqual({ connections: [], skipped: 0, skippedReasons: {}, pending: 0 });
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
    expect(res1).toEqual({ connections: [], skipped: 0, skippedReasons: {}, pending: 0 });
    expect(res2).toEqual({ connections: [], skipped: 0, skippedReasons: {}, pending: 0 });
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

  it('usage requests never exceed 8 in flight', async () => {
    let currentInFlight = 0;
    let maxInFlight = 0;
    const connections = Array.from({ length: 20 }, (_, i) => ({ id: `conn-${i}`, provider: 'codex' }));

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
    expect(result.connections).toHaveLength(20);
    expect(result.skipped).toBe(0);
    expect(maxInFlight).toBe(8);
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
    await expect(client.fetchServer(SERVER)).resolves.toEqual({ connections: [], skipped: 0, skippedReasons: {}, pending: 0 });
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

  it('fetchServer populates progress object in place as each usage call settles', async () => {
    const { fetchImpl } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => listResponse([
        { id: 'a', provider: 'codex' },
        { id: 'b', provider: 'codex' },
        { id: 'c', provider: 'codex' },
      ]),
      '/api/usage/:id': ({ pathname }) => {
        if (pathname.endsWith('/b')) return new Response('fail', { status: 500 });
        return codexUsage(20);
      },
    });
    const client = createNineRouterClient({ fetchImpl });
    const progress = {};
    const result = await client.fetchServer(SERVER, { progress });
    expect(progress.listed).toBe(true);
    expect(progress.total).toBe(3);
    expect(progress.connections).toHaveLength(2);
    expect(progress.skipped).toBe(1);
    expect(progress.skippedReasons).toEqual({ 'HTTP 500': 1 });
    expect(result.connections).toEqual(progress.connections);
    expect(result.skipped).toBe(1);
    expect(result.pending).toBe(0);
  });

  it('fetchServer categorises timeouts into skippedReasons', async () => {
    const { fetchImpl } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => listResponse([
        { id: 'a', provider: 'codex' },
        { id: 'b', provider: 'codex' },
      ]),
      '/api/usage/:id': ({ pathname }) => {
        if (pathname.endsWith('/b')) throw new DOMException('timed out', 'TimeoutError');
        return codexUsage(30);
      },
    });
    const client = createNineRouterClient({ fetchImpl });
    const result = await client.fetchServer(SERVER);
    expect(result.connections).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons).toEqual({ timeout: 1 });
  });

  it('fetchServerCached returns partial snapshot at deadline with pending count, then next call after background completion returns full result without new network calls', async () => {
    let unblockRemaining;
    const remainingPromise = new Promise((resolve) => {
      unblockRemaining = resolve;
    });

    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => listResponse([
        { id: 'a', provider: 'codex' },
        { id: 'b', provider: 'codex' },
        { id: 'c', provider: 'codex' },
        { id: 'd', provider: 'codex' },
      ]),
      '/api/usage/:id': async ({ pathname }) => {
        if (pathname.endsWith('/c') || pathname.endsWith('/d')) {
          await remainingPromise;
        }
        return codexUsage(25);
      },
    });

    const client = createNineRouterClient({ fetchImpl, partialAfterMs: 40 });
    const snapshot = await client.fetchServerCached(SERVER);

    expect(snapshot.pending).toBe(2);
    expect(snapshot.connections).toHaveLength(2);
    expect(snapshot.skipped).toBe(0);
    expect(snapshot.skippedReasons).toEqual({});

    const listCallsBefore = calls.filter((c) => c.path.startsWith('/api/providers/client')).length;
    expect(listCallsBefore).toBe(1);

    unblockRemaining();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const fullResult = await client.fetchServerCached(SERVER);
    expect(fullResult.pending).toBe(0);
    expect(fullResult.connections).toHaveLength(4);
    expect(fullResult.skipped).toBe(0);

    const listCallsAfter = calls.filter((c) => c.path.startsWith('/api/providers/client')).length;
    expect(listCallsAfter).toBe(1);
  });

  it('fetchServerCached returns stale value immediately and starts exactly one background refresh', async () => {
    let time = 0;
    let unblockRefresh;
    const refreshGate = new Promise((resolve) => {
      unblockRefresh = resolve;
    });
    let listCallCount = 0;

    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => {
        listCallCount++;
        return listResponse([{ id: 'a', provider: 'codex' }]);
      },
      '/api/usage/:id': async () => {
        if (listCallCount > 1) {
          await refreshGate;
        }
        return codexUsage(40);
      },
    });

    const client = createNineRouterClient({ fetchImpl, now: () => time });
    const initial = await client.fetchServerCached(SERVER);
    expect(initial.connections).toHaveLength(1);
    expect(calls.filter((c) => c.path.startsWith('/api/providers/client'))).toHaveLength(1);

    time += 65_000;

    const stale1 = await client.fetchServerCached(SERVER);
    const stale2 = await client.fetchServerCached(SERVER);
    expect(stale1).toBe(initial);
    expect(stale2).toBe(initial);
    expect(calls.filter((c) => c.path.startsWith('/api/providers/client'))).toHaveLength(2);

    unblockRefresh();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const fresh = await client.fetchServerCached(SERVER);
    expect(fresh.connections).toHaveLength(1);
    expect(calls.filter((c) => c.path.startsWith('/api/providers/client'))).toHaveLength(2);
  });

  it('background refresh rejection does not produce an unhandled rejection and replaces cache for next call', async () => {
    let time = 0;
    let listCallCount = 0;
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    try {
      const { fetchImpl } = makeFetch({
        '/api/auth/login': () => cookieResponse(),
        '/api/providers/client': () => {
          listCallCount++;
          if (listCallCount > 1) {
            return new Response('Bad Gateway', { status: 502 });
          }
          return listResponse([{ id: 'a', provider: 'codex' }]);
        },
        '/api/usage/:id': () => codexUsage(10),
      });

      const client = createNineRouterClient({ fetchImpl, now: () => time });
      const initial = await client.fetchServerCached(SERVER);
      expect(initial.connections).toHaveLength(1);

      time += 65_000;

      const stale = await client.fetchServerCached(SERVER);
      expect(stale).toBe(initial);

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toHaveLength(0);

      await expect(client.fetchServerCached(SERVER)).rejects.toThrow('connection list failed (HTTP 502)');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('stale entry -> checkLogin -> fetchServerCached (new flight) -> old flight settles later -> cache holds the new flight result and exactly one new flight was started', async () => {
    let time = 0;
    let listCallCount = 0;
    let unblockFlight1;
    const flight1Gate = new Promise((resolve) => {
      unblockFlight1 = resolve;
    });

    const { fetchImpl, calls } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': async () => {
        listCallCount++;
        if (listCallCount === 1) {
          return listResponse([{ id: 'init', provider: 'codex' }]);
        }
        if (listCallCount === 2) {
          await flight1Gate;
          return listResponse([{ id: 'flight1', provider: 'codex' }]);
        }
        return listResponse([{ id: 'flight2', provider: 'codex' }]);
      },
      '/api/usage/:id': ({ pathname }) => {
        if (pathname.endsWith('/flight2')) return codexUsage(80);
        if (pathname.endsWith('/flight1')) return codexUsage(10);
        return codexUsage(50);
      },
    });

    const client = createNineRouterClient({ fetchImpl, now: () => time });

    const initial = await client.fetchServerCached(SERVER);
    expect(initial.connections).toHaveLength(1);
    expect(initial.connections[0].windows[0].usedPercent).toBe(50);

    time += 65_000;

    const stale = await client.fetchServerCached(SERVER);
    expect(stale).toBe(initial);
    expect(listCallCount).toBe(2);

    await client.checkLogin(SERVER);

    const flight2Promise = client.fetchServerCached(SERVER);
    const res2 = await flight2Promise;
    expect(res2.connections).toHaveLength(1);
    expect(res2.connections[0].windows[0].usedPercent).toBe(80);
    expect(listCallCount).toBe(3);

    unblockFlight1();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const finalCached = await client.fetchServerCached(SERVER);
    expect(finalCached.connections[0].windows[0].usedPercent).toBe(80);
    expect(calls.filter((c) => c.path.startsWith('/api/providers/client'))).toHaveLength(3);
  });

  it('fetch rejects before the deadline with no cache -> rejection', async () => {
    const { fetchImpl } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': () => new Response('Bad Gateway', { status: 502 }),
    });
    const client = createNineRouterClient({ fetchImpl, partialAfterMs: 20_000 });
    await expect(client.fetchServerCached(SERVER)).rejects.toThrow('connection list failed (HTTP 502)');
  });

  it('cached rejection within 60 s makes no network call', async () => {
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
  });

  it('returns snapshot with pending: null when the connection list has not loaded by the deadline', async () => {
    let unblockClientList;
    const listGate = new Promise((resolve) => {
      unblockClientList = resolve;
    });

    const { fetchImpl } = makeFetch({
      '/api/auth/login': () => cookieResponse(),
      '/api/providers/client': async () => {
        await listGate;
        return listResponse([{ id: 'a', provider: 'codex' }]);
      },
      '/api/usage/:id': () => codexUsage(20),
    });

    const client = createNineRouterClient({ fetchImpl, partialAfterMs: 30 });
    const snapshot = await client.fetchServerCached(SERVER);

    expect(snapshot.pending).toBeNull();
    expect(snapshot.connections).toEqual([]);
    expect(snapshot.skipped).toBe(0);
    expect(snapshot.skippedReasons).toEqual({});

    unblockClientList();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const complete = await client.fetchServerCached(SERVER);
    expect(complete.pending).toBe(0);
    expect(complete.connections).toHaveLength(1);
  });
});
