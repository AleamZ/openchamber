import { readManagedCredential } from '../../credentials/providers.js';
import { buildResult } from '../../utils/index.js';
import { createNineRouterClient } from './client.js';
import { aggregateServer } from './transforms.js';

export const providerId = '9router';
export const providerName = '9Router';
const aliases = ['9router'];

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
      const skipped = settlement.value?.skipped ?? 0;
      if (skipped > 0) {
        const noun = skipped === 1 ? '1 account skipped' : `${skipped} accounts skipped`;
        const reasonsObj = settlement.value?.skippedReasons;
        const reasonEntries = reasonsObj
          ? Object.entries(reasonsObj).filter(([, count]) => count > 0)
          : [];
        if (reasonEntries.length > 0) {
          reasonEntries.sort(([nameA, countA], [nameB, countB]) => {
            if (countB !== countA) return countB - countA;
            return nameA.localeCompare(nameB);
          });
          const detail = reasonEntries.map(([name, count]) => `${name} ${count}`).join(', ');
          errors.push(`${server.name}: ${noun} (${detail})`);
        } else {
          errors.push(`${server.name}: ${noun}`);
        }
      }
      const pending = settlement.value?.pending;
      if (pending === null) {
        errors.push(`${server.name}: still loading`);
      } else if (Number.isFinite(pending) && pending > 0) {
        const noun = pending === 1 ? '1 account still loading' : `${pending} accounts still loading`;
        errors.push(`${server.name}: ${noun}`);
      }
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
    error,
  });
};

export const validateCredential = async (credential, client = defaultClient) => {
  const servers = credential?.servers ?? [];
  const settlements = await Promise.allSettled(servers.map((s) => client.checkLogin(s)));
  const failures = [];
  settlements.forEach((settlement, index) => {
    if (settlement.status === 'rejected') {
      const server = servers[index];
      const reason = settlement.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      failures.push(`${server.name}: ${message}`);
    }
  });
  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
};
