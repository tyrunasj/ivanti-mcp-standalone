// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

describe('createRateLimiter', () => {
  it('limits nothing when no limit is set', () => {
    const limiter = createRateLimiter(undefined);
    for (let i = 0; i < 1000; i += 1) expect(limiter.admit(i)).toBeUndefined();
  });

  it('refuses the call past the limit and says how long until one fits', () => {
    const limiter = createRateLimiter(2);
    expect(limiter.admit(1_000)).toBeUndefined();
    expect(limiter.admit(2_000)).toBeUndefined();
    expect(limiter.admit(10_000)).toEqual({ retryAfterSeconds: 51 });
  });

  it('does not count a refused call, and admits again once the minute has passed', () => {
    const limiter = createRateLimiter(1);
    limiter.admit(0);
    expect(limiter.admit(30_000)).toBeDefined();
    expect(limiter.admit(60_000)).toBeUndefined();
  });
});
