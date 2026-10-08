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

const serverKey = (server) => crypto.createHash('sha256').update(`${server.url}\n${server.password}`).digest('hex');

const readAuthCookie = (response) => {
  const headers = typeof response.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers?.get('set-cookie') ?? ''];
  for (const header of headers) {
    const match = /(?:^|[,;]\s*)auth_token=([^;,\s]+)/.exec(header);
    if (match) return `auth_token=${match[1]}`;
  }
  return null;
};

const toRequestError = (error) => {
  if (
    (typeof DOMException !== 'undefined' && error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
    error?.name === 'TimeoutError'
  ) {
    return new Error('request timed out');
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
      return cookie;
    }

    const payload = await response.json().catch(() => null);

    if (response.status === 401) {
      throw new LoginRejected('wrong dashboard password');
    }

    if (response.status === 429) {
      const retryHeader = response.headers?.get('Retry-After');
      const retrySeconds = toNumber(retryHeader) ?? toNumber(asObject(payload)?.retryAfter) ?? DEFAULT_LOCKOUT_SECONDS;
      const seconds = Math.max(1, Math.ceil(retrySeconds));
      throw new LoginLocked(seconds);
    }

    const errorMsg = asNonEmptyString(asObject(payload)?.error);
    const detail = errorMsg || `HTTP ${response.status}`;
    throw new LoginRejected(`dashboard login rejected: ${detail}`);
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
    }
  };

  const getJson = async (server, path, cookie) => {
    const headers = cookie ? { Cookie: cookie } : undefined;
    const response = await send(`${server.url}${path}`, { headers });
    let payload;
    try {
      payload = await response.json();
    } catch {
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
    await login(server);
  };

  return { fetchServer, fetchServerCached, checkLogin };
};
