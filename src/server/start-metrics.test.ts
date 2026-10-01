// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import type { Config } from '../config/env-schema.js';
import type { Logger } from '../logger.js';
import { createRegistry } from '../metrics/registry.js';
import { ListenError } from './start-http.js';
import { startMetrics, type MetricsServer } from './start-metrics.js';

type LogCall = (message: string, fields?: Record<string, unknown>) => void;
type SpyLogger = { [K in keyof Logger]: Mock<LogCall> };

const spyLogger = (): SpyLogger => ({
  debug: vi.fn<LogCall>(),
  info: vi.fn<LogCall>(),
  warn: vi.fn<LogCall>(),
  error: vi.fn<LogCall>(),
});

const TOKEN = 'm'.repeat(40);

const metricsConfig = (overrides: Partial<Config> = {}): Config =>
  configFixture({ METRICS_ON: true, METRICS_BIND: '127.0.0.1', METRICS_PORT: 0, ...overrides });

const running: MetricsServer[] = [];
const blockers: NetServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  await Promise.all(
    blockers.splice(0).map((blocker) => new Promise<void>((resolve) => blocker.close(() => resolve()))),
  );
});

async function start(overrides: Partial<Config> = {}, logger = spyLogger()): Promise<string> {
  const registry = createRegistry();
  registry.counter('probe_total', 'A probe.').inc();
  const server = await startMetrics(metricsConfig(overrides), logger, registry);
  running.push(server);
  return `http://127.0.0.1:${String((server.server.address() as AddressInfo).port)}`;
}

describe('startMetrics', () => {
  it('serves the registry at /metrics in the text format', async () => {
    const base = await start();

    const response = await fetch(`${base}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(await response.text()).toContain('probe_total 1');
  });

  it('serves nothing else', async () => {
    const base = await start();

    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/mcp`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
  });

  // DNS rebinding: a page re-pointed at 127.0.0.1 reads this port as its own origin. A same-origin
  // GET carries no Origin, but every modern browser sends Sec-Fetch-Site; no scraper sends either.
  it('refuses a browser', async () => {
    const base = await start();

    expect((await fetch(`${base}/metrics`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/metrics`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(403);
  });

  it('asks for the token when one is set, and accepts only that one', async () => {
    const base = await start({ METRICS_TOKEN: TOKEN });

    const missing = await fetch(`${base}/metrics`);
    const wrong = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${'x'.repeat(40)}` } });
    const right = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } });

    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="metrics"');
    expect(wrong.status).toBe(401);
    expect(right.status).toBe(200);
  });

  it('warns when it answers beyond this machine with no token', async () => {
    const logger = spyLogger();

    await start({ METRICS_BIND: '0.0.0.0' }, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      'metrics listen beyond this machine with no token',
      expect.objectContaining({ bind: '0.0.0.0' }),
    );
  });

  it('names its own settings when the port is taken', async () => {
    const blocker = createNetServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;
    const logger = spyLogger();

    const failure = startMetrics(metricsConfig({ METRICS_PORT: taken }), logger, createRegistry());

    await expect(failure).rejects.toBeInstanceOf(ListenError);
    await expect(failure).rejects.toThrow(/already in use.*METRICS_PORT/);
    expect(logger.info).not.toHaveBeenCalledWith('serving metrics', expect.anything());
  });
});
