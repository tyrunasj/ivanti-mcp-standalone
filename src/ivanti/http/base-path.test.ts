// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { probeBasePath, type ProbeFetch } from './base-path.js';

const CSDL = '<?xml version="1.0"?><edmx:Edmx Version="1.0"><edmx:DataServices/></edmx:Edmx>';

/** Answers CSDL for URLs containing every one of `serves`, and 404 for everything else. */
const tenant = (...serves: string[]): ProbeFetch =>
  vi.fn((url: string) => {
    const hit = serves.every((fragment) => url.includes(fragment));
    return Promise.resolve({
      ok: hit,
      status: hit ? 200 : 404,
      text: () => Promise.resolve(hit ? CSDL : '{"code":"ISM_4004"}'),
    });
  });

describe('probeBasePath', () => {
  it('finds the /HEAT prefix when the tenant uses it', async () => {
    const probe = await probeBasePath('https://t', 'k', tenant('/HEAT/'));

    expect(probe.basePath).toBe('/HEAT');
    expect(probe.metadataUrl).toBe('https://t/HEAT/api/odata/incidents/$metadata');
  });

  it('falls back to the root when the tenant has no prefix', async () => {
    const probe = await probeBasePath('https://t', 'k', tenant('https://t/api/odata'));

    expect(probe.basePath).toBe('');
    expect(probe.attempted[0]?.status).toBe(404); // /HEAT tried first
  });

  it('walks the CSDL ladder when the entity-scoped graph is the one that is disabled', async () => {
    const probe = await probeBasePath('https://t', 'k', tenant('/businessobject/$metadata'));

    expect(probe.metadataUrl).toBe('https://t/HEAT/api/odata/businessobject/$metadata');
    expect(probe.basePath).toBe('/HEAT');
  });

  it('asks for XML — JSON turns $metadata into a 500', async () => {
    const seen: Record<string, string>[] = [];
    const spy: ProbeFetch = (_url, init) => {
      seen.push(init.headers);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(CSDL) });
    };

    await probeBasePath('https://t', 'super-secret', spy);

    expect(seen[0]?.Accept).toBe('application/xml');
    expect(seen[0]?.Authorization).toBe('rest_api_key=super-secret');
  });

  it('rejects a 200 that is not CSDL — a login page must not be taken as success', async () => {
    const html: ProbeFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>Sign in</body></html>'),
      });

    await expect(probeBasePath('https://t', 'k', html)).rejects.toThrow(/Could not reach Ivanti/);
  });

  it('keeps probing after a transport error', async () => {
    const flaky: ProbeFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(CSDL) });

    const probe = await probeBasePath('https://t', 'k', flaky);

    expect(probe.attempted[0]?.status).toBe('error');
    expect(probe.metadataUrl).toBe('https://t/HEAT/api/odata/$metadata');
  });

  it('distinguishes a refused key from an unreachable tenant', async () => {
    const refuses: ProbeFetch = () =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"code":"ISM_4001"}'),
      });

    // A 401 proves the tenant is there and answered; only the credential is wrong.
    await expect(probeBasePath('https://t', 'k', refuses)).rejects.toThrow(/refused the API key/);
    await expect(probeBasePath('https://t', 'k', refuses)).rejects.not.toThrow(
      /Could not reach/,
    );
  });

  /**
   * The probe was the one Ivanti request that bypassed `exchange()`, and its `catch {}` recorded a
   * network failure as the word "error" — so a hostname that did not resolve, a firewall and a
   * TLS-intercepting proxy all failed the startup with the same message.
   */
  it('says why an unreachable tenant could not be reached', async () => {
    const unresolvable: ProbeFetch = () =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND tneant.example.com'), {
            code: 'ENOTFOUND',
          }),
        }),
      );

    await expect(probeBasePath('https://tneant.example.com', 'k', unresolvable)).rejects.toThrow(
      /ENOTFOUND tneant\.example\.com/,
    );
  });

  it('never lets the key into the reason', async () => {
    const echoes: ProbeFetch = () => Promise.reject(new Error('refused while sending secret-key'));

    await expect(probeBasePath('https://t', 'secret-key', echoes)).rejects.not.toThrow(
      /secret-key/,
    );
  });

  it('logs each attempt like every other Ivanti request', async () => {
    const debug = vi.fn();

    await probeBasePath('https://t', 'k', tenant('/HEAT/'), 1_000, {
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    expect(debug).toHaveBeenCalledWith(
      'ivanti request',
      expect.objectContaining({ path: '/HEAT/api/odata/incidents/$metadata', status: 200 }),
    );
  });

  it('reports every URL it tried when nothing works', async () => {
    const dead = tenant('never-matches');

    await expect(probeBasePath('https://t', 'k', dead)).rejects.toThrow(
      /\/HEAT\/api\/odata\/incidents[\s\S]*\/api\/odata\/businessobject/,
    );
  });
});
