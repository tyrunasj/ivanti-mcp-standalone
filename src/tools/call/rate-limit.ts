// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * `MCP_MAX_CALLS_PER_MINUTE`, per conversation. Omitted means nothing is limited — the shape every
 * test wants.
 */
export interface RateLimiter {
  /** Counts the call, or says how many seconds until one would be admitted. */
  admit: (at: number) => { retryAfterSeconds: number } | undefined;
  readonly limit: number | undefined;
}

export function createRateLimiter(limit: number | undefined): RateLimiter {
  // When each call of the last minute arrived, oldest first.
  const recent: number[] = [];
  return {
    limit,
    admit: (at): { retryAfterSeconds: number } | undefined => {
      if (limit === undefined) return undefined;
      while (recent.length > 0 && at - (recent[0] ?? at) >= 60_000) recent.shift();
      if (recent.length >= limit) {
        return {
          retryAfterSeconds: Math.max(1, Math.ceil(((recent[0] ?? at) + 60_000 - at) / 1000)),
        };
      }
      recent.push(at);
      return undefined;
    },
  };
}
