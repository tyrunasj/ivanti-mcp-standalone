// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeIvantiRequests } from '../../observe-ivanti.js';
import {
  countIvantiRequest,
  recordIvantiRequest,
  recordIvantiRequestNotSent,
  setRequestObserver,
} from './request-observer.js';

afterEach(() => {
  // The vitest setup file installs the real observer; put it back for the next file's sake.
  observeIvantiRequests();
});

describe('request observer', () => {
  it('reports to whoever the composition root installed', () => {
    const observer = { sent: vi.fn(), answered: vi.fn(), notSent: vi.fn() };
    setRequestObserver(observer);

    countIvantiRequest();
    recordIvantiRequest('GET', 200, 5);
    recordIvantiRequestNotSent();

    expect(observer.sent).toHaveBeenCalledTimes(1);
    expect(observer.answered).toHaveBeenCalledWith('GET', 200, 5);
    expect(observer.notSent).toHaveBeenCalledTimes(1);
  });

  it('says nothing, and does not throw, when nobody is listening', () => {
    setRequestObserver(undefined);

    expect(() => {
      countIvantiRequest();
      recordIvantiRequest('GET', 200, 5);
      recordIvantiRequestNotSent();
    }).not.toThrow();
  });
});
