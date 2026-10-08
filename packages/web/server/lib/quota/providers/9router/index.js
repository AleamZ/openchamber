import { readManagedCredential } from '../../credentials/providers.js';
import { buildResult } from '../../utils/index.js';
import { createNineRouterClient } from './client.js';
import { aggregateServer } from './transforms.js';

export const providerId = '9router';
export const providerName = '9Router';
export const aliases = ['9router'];

const defaultClient = createNineRouterClient();

const readStoredCredential = () => readManagedCredential(providerId);

export const isConfigured = () => Boolean(readManagedCredential(providerId));

export const fetchQuota = async ({
  readCredential = readStoredCredential,
  client = defaultClient,
} = {}) => {
  const credential = readCredential();
  if (!credential) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const servers = credential.servers ?? [];
  const settlements = await Promise.allSettled(servers.map((s) => client.fetchServerCached(s)));

  let models = {};
  const errors = [];
  let fulfilledCount = 0;

  settlements.forEach((settlement, index) => {
    const server = servers[index];
    if (settlement.status === 'fulfilled') {
      fulfilledCount += 1;
      const serverModels = aggregateServer(server.name, settlement.value?.connections);
      models = { ...models, ...serverModels };
    } else {
      const reason = settlement.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      errors.push(`${server.name}: ${message}`);
    }
  });

  const ok = fulfilledCount > 0;
  const usage = ok ? { windows: {}, models } : null;
  let error;
  if (errors.length > 0) {
    error = errors.join('; ');
  } else if (ok && Object.keys(models).length === 0) {
    error = 'No 9Router accounts report quota';
  }

  return buildResult({
    providerId,
    providerName,
    ok,
    configured: true,
    usage,
    ...(error ? { error } : {}),
  });
};

export const validateCredential = async (credential, client = defaultClient) => {
  const servers = credential?.servers ?? [];
  for (const server of servers) {
    try {
      await client.checkLogin(server);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${server.name}: ${message}`);
    }
  }
};
