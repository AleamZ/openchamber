import { asNonEmptyString, asObject, toNumber, toUsageWindow } from '../../utils/index.js';

const PROVIDER_LABELS = {
  codex: 'Codex',
  claude: 'Claude',
  antigravity: 'Antigravity',
  'gemini-cli': 'Gemini CLI',
  github: 'Copilot',
  kiro: 'Kiro',
};

// Antigravity also reports one quota per model; the four group windows carry
// the limits that actually stop requests, and per-model rows made the list unreadable.
const ANTIGRAVITY_GROUP_KEYS = new Set(['gemini_session', 'gemini_weekly', 'claude_gpt_session', 'claude_gpt_weekly']);

export const providerLabel = (provider) => PROVIDER_LABELS[provider] ?? provider;

const clampPercent = (value) => Math.min(100, Math.max(0, value));

const asRecord = (value) => {
  const obj = asObject(value);
  return Array.isArray(obj) ? null : obj;
};

const toResetTimestamp = (value) => {
  const str = asNonEmptyString(value);
  if (str === null) {
    return Number.isFinite(value) ? value : null;
  }
  const numeric = toNumber(str);
  if (numeric !== null && numeric > 0) return numeric;
  const parsed = Date.parse(str);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseNumber = (value) => {
  const str = asNonEmptyString(value);
  if (str !== null) return toNumber(str);
  return Number.isFinite(value) ? value : null;
};

// 9Router reports `remaining` in the same unit as `total` for every provider:
// percent points for Codex/Claude (total 100), counts for Kiro/Copilot. Prefer
// it when present; fall back to `used`.
const quotaUsedPercent = (quota) => {
  if (!quota || quota.unlimited === true) return null;
  const total = parseNumber(quota.total);
  if (total === null || total <= 0) return null;
  const remaining = parseNumber(quota.remaining);
  if (remaining !== null) return clampPercent(((total - remaining) * 100) / total);
  const used = parseNumber(quota.used);
  return used === null ? null : clampPercent((used * 100) / total);
};

export const connectionWindows = (provider, usage) => {
  const quotas = asRecord(asRecord(usage)?.quotas) ?? {};
  const windows = [];
  for (const [windowKey, rawQuota] of Object.entries(quotas)) {
    if (provider === 'antigravity' && !ANTIGRAVITY_GROUP_KEYS.has(windowKey)) continue;
    const quota = asRecord(rawQuota);
    const usedPercent = quotaUsedPercent(quota);
    if (usedPercent === null) continue;
    windows.push({ windowKey, usedPercent, resetAt: toResetTimestamp(quota.resetAt) });
  }
  return windows;
};

const accountLabel = (count, exhausted) => (exhausted > 0 ? `${count} acc · ${exhausted} exhausted` : `${count} acc`);

export const aggregateServer = (serverName, connections) => {
  const groups = new Map();
  for (const { provider, windows = [] } of (connections ?? [])) {
    for (const window of windows) {
      const key = `${serverName} · ${providerLabel(provider)} · ${window.windowKey}`;
      const group = groups.get(key) ?? { windowKey: window.windowKey, percents: [], resets: [] };
      group.percents.push(window.usedPercent);
      if (window.resetAt !== null) group.resets.push(window.resetAt);
      groups.set(key, group);
    }
  }
  const models = {};
  for (const [key, group] of groups) {
    const average = group.percents.reduce((sum, value) => sum + value, 0) / group.percents.length;
    const exhausted = group.percents.filter((value) => value >= 100).length;
    models[key] = {
      windows: {
        [group.windowKey]: toUsageWindow({
          usedPercent: Math.round(average * 10) / 10,
          windowSeconds: null,
          resetAt: group.resets.length > 0 ? Math.min(...group.resets) : null,
          valueLabel: accountLabel(group.percents.length, exhausted),
        }),
      },
    };
  }
  return models;
};
