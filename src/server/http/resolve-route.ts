// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

export type Route = 'health' | 'ready' | 'oauth-metadata' | 'mcp' | 'not-found';

export const HEALTH_PATH = '/health';
/** Whether to send traffic here: the tenant still answers. `/health` is only whether it is alive. */
export const READY_PATH = '/ready';
export const MCP_PATH = '/mcp';

/**
 * Maps a request path to the route that serves it.
 *
 * Pure and separate from the handlers so that routing can be asserted directly — the ordering
 * matters (`/health`, `/ready` and the metadata document are reachable without a token, everything else
 * is not) and that is exactly the kind of thing that should not need a live server to verify.
 */
export function resolveRoute(url: string | undefined, oauthPaths: ReadonlySet<string>): Route {
  const path = (url ?? '').split('?')[0] ?? '';

  if (path === HEALTH_PATH) return 'health';
  if (path === READY_PATH) return 'ready';
  if (oauthPaths.has(path)) return 'oauth-metadata';
  if (path === MCP_PATH) return 'mcp';
  return 'not-found';
}
