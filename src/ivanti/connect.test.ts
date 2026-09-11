import { describe, expect, it, vi } from 'vitest';
import { createLogger, type Logger } from '../logger.js';
import { connectIvanti } from './connect.js';

const CSDL = '<?xml version="1.0"?><edmx:Edmx Version="1.0"><edmx:DataServices/></edmx:Edmx>';

function testLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger('debug', (line) => lines.push(line)), lines };
}

/** Answers CSDL under `/HEAT` only, or only at the root. */
const tenant = (prefixed: boolean) =>
  vi.fn((url: string) => {
    const hit = url.includes('/HEAT/') === prefixed;
    return Promise.resolve({
      ok: hit,
      status: hit ? 200 : 404,
      text: () => Promise.resolve(hit ? CSDL : 'nope'),
    });
  });

describe('connectIvanti', () => {
  it('probes once and hands back a transport bound to the base path it found', async () => {
    const fetchImpl = tenant(true);
    const { logger } = testLogger();

    const connection = await connectIvanti({ baseUrl: 'https://t', apiKey: 'k', logger, fetchImpl });

    expect(connection.basePath).toBe('/HEAT');
    expect(connection.metadataUrl).toBe('https://t/HEAT/api/odata/incidents/$metadata');
    expect(connection.transport.routes.entitySet('Incidents')).toBe(
      'https://t/HEAT/api/odata/businessobject/Incidents',
    );
    // One probe for the base path; the rest of the calls are the session handshake.
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes('$metadata'))).toHaveLength(1);
  });

  it('logs the root base path as something a reader cannot mistake for "unknown"', async () => {
    const fetchImpl = tenant(false);
    const { logger, lines } = testLogger();

    const connection = await connectIvanti({ baseUrl: 'https://t', apiKey: 'k', logger, fetchImpl });

    expect(connection.basePath).toBe('');
    expect(connection.transport.routes.entitySet('Incidents')).toBe(
      'https://t/api/odata/businessobject/Incidents',
    );
    expect(lines.join('\n')).toContain('"basePath":"(root)"');
  });

  it('never logs the API key', async () => {
    const { logger, lines } = testLogger();

    await connectIvanti({
      baseUrl: 'https://t',
      apiKey: 'super-secret',
      logger,
      fetchImpl: tenant(true),
    });

    expect(lines.join('\n')).not.toContain('super-secret');
  });

  it('fails rather than returning a client that cannot reach the tenant', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('nope') }),
    );
    const { logger } = testLogger();

    await expect(
      connectIvanti({ baseUrl: 'https://t', apiKey: 'k', logger, fetchImpl }),
    ).rejects.toThrow(/Could not reach Ivanti/);
  });

  it('says the key was refused rather than blaming the URL', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"code":"ISM_4001"}'),
      }),
    );
    const { logger } = testLogger();

    await expect(
      connectIvanti({ baseUrl: 'https://t', apiKey: 'k', logger, fetchImpl }),
    ).rejects.toThrow(/refused the API key: 401[\s\S]*IVANTI_API_KEY/);
  });

  it('degrades to the OData tier when the session handshake fails', async () => {
    // The realistic case: a key whose role cannot open an ASMX session. Reads still work, so
    // refusing to start would punish exactly the customers who cannot issue an admin key.
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('$metadata')
          ? { ok: true, status: 200, text: () => Promise.resolve(CSDL) }
          : { ok: false, status: 401, text: () => Promise.resolve('ISM_4001') },
      ),
    );
    const { logger, lines } = testLogger();

    const connection = await connectIvanti({ baseUrl: 'https://t', apiKey: 'k', logger, fetchImpl });

    expect(connection.capability.tier).toBe('odata');
    expect(lines.join('\n')).toContain('session unavailable');
  });

  it('reports the admin tier when the console answers as well', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.includes('$metadata')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(CSDL) });
      }
      const body = url.includes('AuthenticateTenantAPIKey')
        ? { d: 'sid' }
        : url.includes('InitializeSession')
          ? { d: { SessionCsrfToken: 'csrf', ActiveRole: 'Admin' } }
          : url.includes('GetBriefBusinessObjects')
            ? { d: [{ id: 'Incident#', displayName: 'Incident' }] }
            : { d: { UserRole: 'Admin', DisplayName: 'Service Account' } };
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    });
    const { logger } = testLogger();

    const connection = await connectIvanti({ baseUrl: 'https://t', apiKey: 'k', logger, fetchImpl });

    expect(connection.capability).toMatchObject({
      tier: 'admin',
      identity: { role: 'Admin', displayName: 'Service Account' },
    });
  });

  it('falls back to the session tier when only the admin console refuses', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.includes('$metadata')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(CSDL) });
      }
      if (url.includes('AdminUI')) {
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('no') });
      }
      const body = url.includes('AuthenticateTenantAPIKey')
        ? { d: 'sid' }
        : { d: { SessionCsrfToken: 'csrf', ActiveRole: 'ServiceDeskAnalyst' } };
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    });
    const { logger } = testLogger();

    const connection = await connectIvanti({ baseUrl: 'https://t', apiKey: 'k', logger, fetchImpl });

    expect(connection.capability.tier).toBe('session');
  });
});
