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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
});
