import { deleteQuotaCredential, readQuotaCredential, writeQuotaCredential } from './store.js';

const clean = (value) => typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : '';

export const normalizers = {
  'exe-dev': (value) => {
    const usageToken = clean(value?.usageToken);
    return usageToken ? { usageToken } : null;
  },
  'ollama-cloud': (value) => {
    const cookie = clean(value?.cookie);
    return cookie ? { cookie } : null;
  },
  cursor: (value) => {
    const accessToken = clean(value?.accessToken);
    const refreshToken = clean(value?.refreshToken);
    return accessToken || refreshToken ? { accessToken, refreshToken } : null;
  },
  zenmux: (value) => {
    const platformApiKey = clean(value?.platformApiKey);
    return platformApiKey ? { platformApiKey } : null;
  },
  '9router': (value) => {
    if (!Array.isArray(value?.servers) || value.servers.length === 0 || value.servers.length > 10) return null;
    const seenNames = new Set();
    const servers = [];
    for (const entry of value.servers) {
      if (!entry || typeof entry !== 'object') return null;
      const name = clean(entry.name);
      if (!name || name.length > 40) return null;
      const lowerName = name.toLowerCase();
      if (seenNames.has(lowerName)) return null;
      seenNames.add(lowerName);

      const password = clean(entry.password);
      if (!password) return null;

      const rawUrl = clean(entry.url);
      if (!rawUrl) return null;
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return null;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

      servers.push({ name, url: parsed.origin, password });
    }
    return { servers };
  },
};

export const readManagedCredential = (providerId) => {
  const normalize = normalizers[providerId];
  return normalize ? readQuotaCredential(providerId, normalize) : null;
};

export const writeManagedCredential = (providerId, value) => {
  const credential = normalizers[providerId]?.(value);
  if (!credential) throw new Error('Invalid credential');
  writeQuotaCredential(providerId, credential);
  return getManagedCredentialStatus(providerId);
};

export const getManagedCredentialStatus = (providerId) => {
  const credential = readManagedCredential(providerId);
  if (!credential) return { configured: false };
  if (providerId === 'cursor') return { configured: true, hasRefreshToken: Boolean(credential.refreshToken), secretMasked: '••••••••' };
  if (providerId === '9router') {
    return {
      configured: true,
      secretMasked: '••••••••',
      servers: credential.servers.map(({ name, url }) => ({ name, url })),
    };
  }
  return { configured: true, secretMasked: '••••••••' };
};

export const deleteManagedCredential = (providerId) => deleteQuotaCredential(providerId);
