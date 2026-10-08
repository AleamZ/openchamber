import { describe, expect, it } from 'vitest';
import { fetchQuota, validateCredential } from './index.js';

const credential = { servers: [
  { name: 'tunnel', url: 'https://a.test', password: 'pw-a' },
  { name: 'vps', url: 'https://b.test', password: 'pw-b' },
] };
const window = (used) => ({ windowKey: 'session', usedPercent: used, resetAt: null });

describe('9Router quota provider', () => {
  it('reports not configured without a credential', async () => {
    const result = await fetchQuota({ readCredential: () => null });
    expect(result).toMatchObject({ providerId: '9router', ok: false, configured: false });
  });

  it('merges every server and names the one that failed', async () => {
    const client = {
      fetchServerCached: async (server) => {
        if (server.name === 'tunnel') throw new Error('wrong dashboard password');
        return { connections: [{ provider: 'codex', windows: [window(40)] }, { provider: 'codex', windows: [window(60)] }], skipped: 0 };
      },
    };
    const result = await fetchQuota({ readCredential: () => credential, client });
    expect(result.ok).toBe(true);
    expect(result.error).toBe('tunnel: wrong dashboard password');
    expect(result.usage.models['vps · Codex · session'].windows.session.usedPercent).toBe(50);
    expect(JSON.stringify(result)).not.toMatch(/pw-/);
  });

  it('fails when every server fails', async () => {
    const client = { fetchServerCached: async () => { throw new Error('request timed out'); } };
    const result = await fetchQuota({ readCredential: () => credential, client });
    expect(result).toMatchObject({ ok: false, configured: true, error: 'tunnel: request timed out; vps: request timed out', usage: null });
  });

  it('says so when no account reports quota', async () => {
    const client = { fetchServerCached: async () => ({ connections: [], skipped: 2 }) };
    const result = await fetchQuota({ readCredential: () => credential, client });
    expect(result).toMatchObject({ ok: true, error: 'No 9Router accounts report quota' });
  });

  it('validates every server login and names the failing one', async () => {
    const checked = [];
    const client = { checkLogin: async (server) => { checked.push(server.name); if (server.name === 'vps') throw new Error('wrong dashboard password'); } };
    await expect(validateCredential(credential, client)).rejects.toThrow('vps: wrong dashboard password');
    expect(checked).toEqual(['tunnel', 'vps']);
  });
});
