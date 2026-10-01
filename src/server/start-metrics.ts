// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from '../config/env-schema.js';
import { isMetricsExposedToNetwork } from '../config/validate-config.js';
import type { Logger } from '../logger.js';
import type { Registry } from '../metrics/registry.js';
import { explainListenFailure, ListenError } from './start-http.js';

export const METRICS_PATH = '/metrics';

/** Prometheus' text format, the version every scraper accepts. */
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** A scrape is one small GET. Anything slower than this is not a scraper. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface MetricsServer {
  server: Server;
  close: () => Promise<void>;
}

/**
 * The metrics listener: its own port, `GET /metrics`, nothing else.
 *
 * Separate from the MCP listener so that no credential guarding the tools is needed to scrape,
 * and so that whatever fronts the MCP port — an ingress, a tunnel, a TLS proxy — never routes
 * here. What it serves names no person, filter or record, but error rates by tool still say what
 * a deployment is used for, so it is loopback by default and can carry a token of its own.
 */
export async function startMetrics(
  config: Config,
  logger: Logger,
  registry: Registry,
): Promise<MetricsServer> {
  const token = config.METRICS_TOKEN;
  const server = createServer((request, response) => {
    answer(request, response, registry, token);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;

  if (isMetricsExposedToNetwork(config) && token === undefined) {
    logger.warn('metrics listen beyond this machine with no token', {
      bind: config.METRICS_BIND,
      hint: 'restrict who reaches METRICS_PORT (a NetworkPolicy, a firewall), or set METRICS_TOKEN',
    });
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      const reason = explainListenFailure(error, config.METRICS_BIND, config.METRICS_PORT, {
        bind: 'METRICS_BIND',
        port: 'METRICS_PORT',
      });
      logger.error('cannot listen for metrics', {
        bind: config.METRICS_BIND,
        port: config.METRICS_PORT,
        code: error.code,
        reason,
      });
      reject(new ListenError(reason, error.code));
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.METRICS_PORT, config.METRICS_BIND);
  });

  const address = server.address();
  logger.info('serving metrics', {
    bind: config.METRICS_BIND,
    port: typeof address === 'object' && address !== null ? address.port : config.METRICS_PORT,
    path: METRICS_PATH,
    token: token !== undefined,
  });

  return {
    server,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
    },
  };
}

function answer(
  request: IncomingMessage,
  response: ServerResponse,
  registry: Registry,
  token: string | undefined,
): void {
  const path = new URL(request.url ?? '/', 'http://metrics').pathname;
  if (path !== METRICS_PATH) return plain(response, 404, 'Not found. Metrics are at /metrics.');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return plain(response, 405, 'Method not allowed.');
  }

  // A browser announces itself, and a scraper never does. Refusing one closes DNS rebinding: a
  // page the operator merely visits, re-pointed at 127.0.0.1, would otherwise read this port as
  // its own origin — and a same-origin GET carries no Origin, but every modern browser sends
  // Sec-Fetch-Site.
  if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) {
    return plain(response, 403, 'Forbidden: metrics are for a scraper, not a browser.');
  }

  if (token !== undefined && !bearerMatches(request.headers.authorization, token)) {
    response.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
    return plain(response, 401, 'Unauthorized.');
  }

  const body = registry.render();
  response.writeHead(200, { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store' });
  response.end(request.method === 'HEAD' ? undefined : body);
}

/** Hashed first, so the comparison takes the same time whatever the length of the guess. */
function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = /^Bearer (.+)$/i.exec(header ?? '')?.[1];
  if (presented === undefined) return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(token));
}

function plain(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(`${text}\n`);
}
