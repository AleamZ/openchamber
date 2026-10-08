import crypto from 'node:crypto';
import { isRecord } from '../../../shared/guards.js';
import { asNonEmptyString, asObject, toNumber } from '../../utils/index.js';
import { connectionWindows } from './transforms.js';

const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_TTL_MS = 23 * 60 * 60 * 1000;
const RESULT_TTL_MS = 60_000;
const USAGE_CONCURRENCY = 4;
const DEFAULT_LOCKOUT_SECONDS = 60;
const LIST_PATH = '/api/providers/client?provider=all&accountStatus=active&page=1&pageSize=500';

class LoginRejected extends Error {}
class LoginLocked extends Error {
  constructor(seconds) {
    super(`dashboard login locked, retry in ${seconds} s`);
    this.seconds = seconds;
  }
}
class RequestTimeout extends Error {}

const serverKey = (server) => crypto.createHash('sha256').update(`${server.url}\n${server.password}`).digest('hex');

const readAuthCookie = (response) => {
  const headers = response.headers.getSetCookie();
  for (const header of headers) {
    const match = /(?:^|[,;]\s*)auth_token=([^;,\s]+)/.exec(header);
    if (match) return `auth_token=${match[1]}`;
  }
  return null;
};

const toRequestError = (error) => {
  if (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return new RequestTimeout('request timed out');
  }
  return error instanceof Error ? error : new Error('request failed');
};

const mapWithLimit = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
};

export const createNineRouterClient = ({ fetchImpl = fetch, now = Date.now } = {}) => {
  const sessions = new Map();
  const results = new Map();
  const logins = new Map();

  const send = async (url, init) => {
    try {
      return await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw toRequestError(error);
    }
  };

  const login = async (server) => {
    const response = await send(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.password }),
    });

    if (response.status >= 200 && response.status < 300) {
      const cookie = readAuthCookie(response);
      if (!cookie) {
        throw new LoginRejected('dashboard login returned no session');
      }
      try {
        await response.body?.cancel();
      } catch {}
      return cookie;
    }

    const payload = await response.json().catch(() => null);

    if (response.status === 401) {
      throw new LoginRejected('wrong dashboard password');
    }

    if (response.status === 429) {
      const retryHeader = asNonEmptyString(response.headers?.get('Retry-After'));
      const retrySeconds = toNumber(retryHeader) ?? toNumber(asObject(payload)?.retryAfter) ?? DEFAULT_LOCKOUT_SECONDS;
      const seconds = retrySeconds > 0 ? Math.ceil(retrySeconds) : DEFAULT_LOCKOUT_SECONDS;
      throw new LoginLocked(seconds);
    }

    if (response.status >= 500) {
      throw new Error(`dashboard login failed (HTTP ${response.status})`);
    }

    const rawError = asNonEmptyString(asObject(payload)?.error);
    const errorMsg = rawError && rawError.length > 200 ? `${rawError.slice(0, 200)}…` : rawError;
    const detail = errorMsg || `HTTP ${response.status}`;
    throw new LoginRejected(`dashboard login rejected: ${detail}`);
  };

  const performLogin = (server, key) => {
    const existing = logins.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        const cookie = await login(server);
        sessions.set(key, { cookie, issuedAt: now() });
        return cookie;
      } catch (error) {
        if (error instanceof LoginRejected) {
          sessions.set(key, { rejected: error.message });
        } else if (error instanceof LoginLocked) {
          sessions.set(key, { lockedUntil: now() + error.seconds * 1000 });
        }
        throw error;
      } finally {
        logins.delete(key);
      }
    })();

    logins.set(key, promise);
    return promise;
  };

  const sessionCookie = async (server, key) => {
    const state = sessions.get(key);
    if (state?.rejected) {
      throw new LoginRejected(state.rejected);
    }
    if (state?.lockedUntil) {
      if (now() < state.lockedUntil) {
        const remaining = Math.max(1, Math.ceil((state.lockedUntil - now()) / 1000));
        throw new LoginLocked(remaining);
      }
      sessions.delete(key);
    }
    if (state?.cookie && (now() - state.issuedAt < SESSION_TTL_MS)) {
      return state.cookie;
    }
    return performLogin(server, key);
  };

  const getJson = async (server, path, cookie) => {
    const headers = cookie ? { Cookie: cookie } : undefined;
    const response = await send(`${server.url}${path}`, { headers });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      const reqError = toRequestError(error);
      if (reqError instanceof RequestTimeout) {
        throw reqError;
      }
      payload = undefined;
    }
    return { response, payload };
  };

  const fetchServer = async (server) => {
    const key = serverKey(server);
    let cookie = await sessionCookie(server, key);

    let { response, payload } = await getJson(server, LIST_PATH, cookie);
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      sessions.delete(key);
      cookie = await sessionCookie(server, key);
      const retried = await getJson(server, LIST_PATH, cookie);
      response = retried.response;
      payload = retried.payload;
      if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
        throw new Error('dashboard session rejected');
      }
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`connection list failed (HTTP ${response.status})`);
    }
    if (!isRecord(payload)) {
      throw new Error('invalid response from 9Router');
    }

    const rawConnections = Array.isArray(payload.connections) ? payload.connections : [];
    const activeConnections = rawConnections.filter(
      (entry) => isRecord(entry) && asNonEmptyString(entry.id) !== null && entry.isActive !== false,
    );

    const usageResults = await mapWithLimit(activeConnections, USAGE_CONCURRENCY, async (connection) => {
      try {
        const id = encodeURIComponent(connection.id);
        const { response: usageRes, payload: usagePayload } = await getJson(server, `/api/usage/${id}`, cookie);
        if (!usageRes || usageRes.status < 200 || usageRes.status >= 300 || !usagePayload) {
          return null;
        }
        const windows = connectionWindows(connection.provider, usagePayload);
        if (!Array.isArray(windows) || windows.length === 0) {
          return null;
        }
        return { provider: connection.provider, windows };
      } catch {
        return null;
      }
    });

    let skipped = 0;
    const connections = [];
    for (const item of usageResults) {
      if (item) {
        connections.push(item);
      } else {
        skipped += 1;
      }
    }

    return { connections, skipped };
  };

  const fetchServerCached = (server) => {
    const key = serverKey(server);
    const cached = results.get(key);
    if (cached) {
      if (cached.settledAt === undefined) {
        return cached.promise;
      }
      if (now() - cached.settledAt < RESULT_TTL_MS) {
        return cached.promise;
      }
    }

    const entry = { settledAt: undefined };
    entry.promise = (async () => {
      try {
        const result = await fetchServer(server);
        entry.settledAt = now();
        return result;
      } catch (error) {
        entry.settledAt = now();
        throw error;
      }
    })();
    results.set(key, entry);
    return entry.promise;
  };

  const checkLogin = async (server) => {
    const key = serverKey(server);
    const state = sessions.get(key);
    if (state?.lockedUntil) {
      if (now() < state.lockedUntil) {
        const remaining = Math.max(1, Math.ceil((state.lockedUntil - now()) / 1000));
        throw new LoginLocked(remaining);
      }
      sessions.delete(key);
    }
    await performLogin(server, key);
    results.delete(key);
  };

  return { fetchServer, fetchServerCached, checkLogin };
};
