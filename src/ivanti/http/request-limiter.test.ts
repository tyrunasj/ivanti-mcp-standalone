// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestLimiter, IvantiBusyError } from './request-limiter.js';

/** A request that answers when told to. */
const pending = () => {
  let answer: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const promise = new Promise<string>((resolve, reject) => {
    answer = () => resolve('answered');
    fail = reject;
  });
  return { send: vi.fn(() => promise), answer, fail };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('createRequestLimiter', () => {
  it('sends at once while under the limit', async () => {
    const limiter = createRequestLimiter(2);
    const a = pending();

    const result = limiter.run(a.send, 1_000);
    a.answer();

    await expect(result).resolves.toBe('answered');
    expect(limiter.inFlight).toBe(0);
  });

  it('holds a request past the limit until a slot frees, then sends it', async () => {
    const limiter = createRequestLimiter(1);
    const first = pending();
    const second = pending();

    const one = limiter.run(first.send, 1_000);
    const two = limiter.run(second.send, 1_000);
    expect(second.send).not.toHaveBeenCalled();
    expect(limiter.waiting).toBe(1);

    first.answer();
    await one;
    await vi.waitFor(() => {
      expect(second.send).toHaveBeenCalled();
    });
    second.answer();

    await expect(two).resolves.toBe('answered');
    expect(limiter.inFlight).toBe(0);
  });

  it('frees the slot when a request fails, not only when it answers', async () => {
    const limiter = createRequestLimiter(1);
    const failing = pending();
    const next = pending();

    const one = limiter.run(failing.send, 1_000);
    const two = limiter.run(next.send, 1_000);
    failing.fail(new Error('Ivanti GET 503'));
    await expect(one).rejects.toThrow('503');
    await vi.waitFor(() => {
      expect(next.send).toHaveBeenCalled();
    });
    next.answer();

    await expect(two).resolves.toBe('answered');
  });

  it('serves the queue in order', async () => {
    const limiter = createRequestLimiter(1);
    const order: string[] = [];
    const first = pending();
    const tracked = (name: string) => () => {
      order.push(name);
      return Promise.resolve(name);
    };

    const held = limiter.run(first.send, 1_000);
    const b = limiter.run(tracked('b'), 1_000);
    const c = limiter.run(tracked('c'), 1_000);
    first.answer();
    await Promise.all([held, b, c]);

    expect(order).toEqual(['b', 'c']);
  });

  // Never sent, so it must not read as "may have been applied" the way a status-0 timeout does.
  it('gives up on a request that waits longer than it may, as one never sent', async () => {
    vi.useFakeTimers();
    const limiter = createRequestLimiter(1);
    const stuck = pending();
    const late = pending();

    void limiter.run(stuck.send, 60_000);
    const waiting = limiter.run(late.send, 500);
    const outcome = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);

    expect(await outcome).toBeInstanceOf(IvantiBusyError);
    expect(late.send).not.toHaveBeenCalled();
    expect(limiter.waiting).toBe(0);
    expect(limiter.inFlight).toBe(1);
  });
});
