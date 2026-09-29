// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { countIvantiRequest, noteOutcome, withCallUsage, type CallUsage } from './call-usage.js';

describe('call usage', () => {
  it('tallies requests and the outcome reported anywhere beneath the call', async () => {
    const usage: CallUsage = { ivantiRequests: 0 };

    await withCallUsage(usage, async () => {
      countIvantiRequest();
      await Promise.resolve();
      countIvantiRequest();
      noteOutcome('UnsupportedFilterError');
    });

    expect(usage).toEqual({ ivantiRequests: 2, outcome: 'UnsupportedFilterError' });
  });

  it('keeps concurrent calls apart', async () => {
    const first: CallUsage = { ivantiRequests: 0 };
    const second: CallUsage = { ivantiRequests: 0 };

    await Promise.all([
      withCallUsage(first, async () => {
        await Promise.resolve();
        countIvantiRequest();
      }),
      withCallUsage(second, async () => {
        countIvantiRequest();
        await Promise.resolve();
        countIvantiRequest();
      }),
    ]);

    expect(first.ivantiRequests).toBe(1);
    expect(second.ivantiRequests).toBe(2);
  });

  it('ignores a request made outside any call, such as the startup probe', () => {
    expect(() => {
      countIvantiRequest();
      noteOutcome('fault');
    }).not.toThrow();
  });
});
