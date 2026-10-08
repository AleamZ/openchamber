import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteManagedCredential,
  getManagedCredentialStatus,
  normalizers,
  readManagedCredential,
  writeManagedCredential,
} from './providers.js';

const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-quota-providers-'));
process.env.OPENCHAMBER_DATA_DIR = temporaryDirectory;

describe('9router managed credentials', () => {
  it('normalizes valid two-server body', () => {
    const body = {
      servers: [
        { name: '  tunnel  ', url: 'https://aleam.io.vn/v1/', password: 'pw-1' },
        { name: 'vps', url: 'http://127.0.0.1:8080/dashboard', password: 'pw-2' },
      ],
    };
    const normalized = normalizers['9router'](body);
    expect(normalized).toEqual({
      servers: [
        { name: 'tunnel', url: 'https://aleam.io.vn', password: 'pw-1' },
        { name: 'vps', url: 'http://127.0.0.1:8080', password: 'pw-2' },
      ],
    });
  });

  it('rejects invalid server payloads', () => {
    const normalize = normalizers['9router'];
    expect(normalize(null)).toBeNull();
    expect(normalize({})).toBeNull();
    expect(normalize({ servers: [] })).toBeNull();
    expect(normalize({ servers: 'not-an-array' })).toBeNull();

    // 11 servers
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      name: `s${i}`,
      url: `https://s${i}.test`,
      password: 'pass',
    }));
    expect(normalize({ servers: eleven })).toBeNull();

    // duplicate names differing only by case
    expect(normalize({
      servers: [
        { name: 'Tunnel', url: 'https://a.test', password: 'pw' },
        { name: 'tunnel', url: 'https://b.test', password: 'pw' },
      ],
    })).toBeNull();

    // ftp:// URL
    expect(normalize({
      servers: [{ name: 'ftp-serv', url: 'ftp://a.test', password: 'pw' }],
    })).toBeNull();

    // unparsable URL
    expect(normalize({
      servers: [{ name: 'bad-url', url: 'not-a-url', password: 'pw' }],
    })).toBeNull();

    // empty password
    expect(normalize({
      servers: [{ name: 'srv', url: 'https://a.test', password: '   ' }],
    })).toBeNull();

    // password containing \n
    expect(normalize({
      servers: [{ name: 'srv', url: 'https://a.test', password: 'pw\nwith-newline' }],
    })).toBeNull();

    // name longer than 40 chars
    expect(normalize({
      servers: [{ name: 'a'.repeat(41), url: 'https://a.test', password: 'pw' }],
    })).toBeNull();
  });

  it('writes and reads status masking passwords', () => {
    const body = {
      servers: [
        { name: 'tunnel', url: 'https://a.test', password: 'secret-a' },
        { name: 'vps', url: 'https://b.test', password: 'secret-b' },
      ],
    };
    const status = writeManagedCredential('9router', body);
    expect(status).toEqual({
      configured: true,
      secretMasked: '••••••••',
      servers: [
        { name: 'tunnel', url: 'https://a.test' },
        { name: 'vps', url: 'https://b.test' },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('secret-a');
    expect(JSON.stringify(status)).not.toContain('secret-b');

    const readStatus = getManagedCredentialStatus('9router');
    expect(readStatus).toEqual(status);
    expect(JSON.stringify(readStatus)).not.toContain('secret-a');
    expect(JSON.stringify(readStatus)).not.toContain('secret-b');
  });

  it('reports not configured after deletion', () => {
    deleteManagedCredential('9router');
    const status = getManagedCredentialStatus('9router');
    expect(status).toEqual({ configured: false });
  });

  it('returns null on malformed file on disk', () => {
    const quotaDir = path.join(temporaryDirectory, 'quota');
    fs.mkdirSync(quotaDir, { recursive: true });
    fs.writeFileSync(path.join(quotaDir, '9router.json'), '{not json', 'utf8');
    const credential = readManagedCredential('9router');
    expect(credential).toBeNull();
  });
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});
