import { describe, expect, it } from 'vitest';
import { aggregateServer, connectionWindows, providerLabel } from './transforms.js';

const RESET_A = '2026-10-08T12:00:00.000Z';
const RESET_B = '2026-10-08T10:00:00.000Z';

describe('9Router quota transforms', () => {
  it('reads percent-based quotas (codex)', () => {
    const windows = connectionWindows('codex', {
      quotas: {
        session: { used: 20, total: 100, remaining: 80, resetAt: RESET_A, unlimited: false },
        weekly: { used: 55, total: 100, remaining: 45, resetAt: null, unlimited: false },
      },
    });
    expect(windows).toEqual([
      { windowKey: 'session', usedPercent: 20, resetAt: Date.parse(RESET_A) },
      { windowKey: 'weekly', usedPercent: 55, resetAt: null },
    ]);
  });

  it('treats remaining as a count when the provider reports absolute values (kiro, github)', () => {
    expect(connectionWindows('kiro', {
      quotas: { agentic_request: { used: 0, total: 50, remaining: 10, resetAt: null, unlimited: false } },
    })).toEqual([{ windowKey: 'agentic_request', usedPercent: 80, resetAt: null }]);
    expect(connectionWindows('github', {
      quotas: { premium_interactions: { used: 150, total: 300, remaining: 150, resetAt: null, unlimited: false } },
    })).toEqual([{ windowKey: 'premium_interactions', usedPercent: 50, resetAt: null }]);
  });

  it('keeps only the four antigravity group quotas', () => {
    const windows = connectionWindows('antigravity', {
      quotas: {
        gemini_session: { used: 100, total: 1000, resetAt: RESET_A, unlimited: false },
        claude_gpt_weekly: { used: 500, total: 1000, resetAt: null, unlimited: false },
        'gemini-3.8-flash': { used: 900, total: 1000, resetAt: null, unlimited: false },
      },
    });
    expect(windows.map((w) => w.windowKey)).toEqual(['gemini_session', 'claude_gpt_weekly']);
    expect(windows[0].usedPercent).toBe(10);
  });

  it.each([
    [{ used: 5, total: 100, unlimited: true }],
    [{ used: 5, total: 0 }],
    [{ used: 5, total: -1 }],
    [{ used: 'x', total: 100 }],
    [{ total: 100 }],
    [null],
    ['nope'],
  ])('skips unusable quota %j', (quota) => {
    expect(connectionWindows('codex', { quotas: { session: quota } })).toEqual([]);
  });

  it.each([[undefined], [null], [{}], [{ message: 'Usage not available for this connection' }], [{ quotas: [] }]])(
    'returns no windows for %j',
    (usage) => { expect(connectionWindows('codex', usage)).toEqual([]); },
  );

  it('clamps percentages into 0..100 and ignores invalid reset dates', () => {
    expect(connectionWindows('codex', {
      quotas: { session: { used: 130, total: 100, resetAt: 'not a date' } },
    })).toEqual([{ windowKey: 'session', usedPercent: 100, resetAt: null }]);
  });

  it('parses numeric strings for total, remaining, and used', () => {
    const windows = connectionWindows('codex', {
      quotas: {
        session: { used: '20', total: '100', remaining: '80', resetAt: null },
      },
    });
    expect(windows).toEqual([{ windowKey: 'session', usedPercent: 20, resetAt: null }]);
  });

  it('treats blank remaining as missing and falls back to used', () => {
    const windows = connectionWindows('codex', {
      quotas: {
        session: { used: 35, total: 100, remaining: '   ', resetAt: null },
      },
    });
    expect(windows).toEqual([{ windowKey: 'session', usedPercent: 35, resetAt: null }]);
  });

  it('accepts numeric epoch-ms resetAt', () => {
    const epochMs = 1728400000000;
    const windows = connectionWindows('codex', {
      quotas: {
        session: { used: 10, total: 100, resetAt: epochMs },
      },
    });
    expect(windows).toEqual([{ windowKey: 'session', usedPercent: 10, resetAt: epochMs }]);
  });

  it('clamps to 0% when remaining exceeds total', () => {
    const windows = connectionWindows('codex', {
      quotas: {
        session: { total: 100, remaining: 125, resetAt: null },
      },
    });
    expect(windows).toEqual([{ windowKey: 'session', usedPercent: 0, resetAt: null }]);
  });

  it('averages accounts of one provider type per window and keeps the earliest reset', () => {
    const models = aggregateServer('9routerVPS', [
      { provider: 'codex', windows: [{ windowKey: 'session', usedPercent: 20, resetAt: Date.parse(RESET_A) }] },
      { provider: 'codex', windows: [{ windowKey: 'session', usedPercent: 90, resetAt: Date.parse(RESET_B) }] },
      { provider: 'codex', windows: [{ windowKey: 'session', usedPercent: 100, resetAt: null }] },
      { provider: 'kiro', windows: [{ windowKey: 'agentic_request', usedPercent: 40, resetAt: null }] },
    ]);
    expect(Object.keys(models)).toEqual(['9routerVPS · Codex · session', '9routerVPS · Kiro · agentic_request']);
    const codex = models['9routerVPS · Codex · session'].windows.session;
    expect(codex.usedPercent).toBe(70);
    expect(codex.remainingPercent).toBe(30);
    expect(codex.resetAt).toBe(Date.parse(RESET_B));
    expect(codex.valueLabel).toBe('3 acc · 1 exhausted');
    expect(models['9routerVPS · Kiro · agentic_request'].windows.agentic_request.valueLabel).toBe('1 acc');
  });

  it('rounds the average to one decimal', () => {
    const models = aggregateServer('s', [
      { provider: 'codex', windows: [{ windowKey: 'weekly', usedPercent: 10, resetAt: null }] },
      { provider: 'codex', windows: [{ windowKey: 'weekly', usedPercent: 10, resetAt: null }] },
      { provider: 'codex', windows: [{ windowKey: 'weekly', usedPercent: 11, resetAt: null }] },
    ]);
    expect(models['s · Codex · weekly'].windows.weekly.usedPercent).toBe(10.3);
  });

  it('returns an empty object when there is nothing to aggregate', () => {
    expect(aggregateServer('s', [])).toEqual({});
    expect(aggregateServer('s', [{ provider: 'codex', windows: [] }])).toEqual({});
  });

  it('labels known provider ids and passes unknown ones through', () => {
    expect(providerLabel('github')).toBe('Copilot');
    expect(providerLabel('gemini-cli')).toBe('Gemini CLI');
    expect(providerLabel('qoder')).toBe('qoder');
  });
});
