// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { IvantiApiError } from '../../ivanti/http/errors.js';
import { withCallUsage, type CallUsage } from '../../usage/call-usage.js';
import { isPersonRefused, tryRead } from './try-read.js';

const refused = (credential: 'person' | 'service') =>
  new IvantiApiError({ status: 401, method: 'GET', url: 'u', credential });

describe('tryRead', () => {
  it('carries the value', async () => {
    await expect(tryRead(Promise.resolve(3))).resolves.toEqual({ ok: true, value: 3 });
  });

  it('carries the failure instead of hiding it', async () => {
    const error = new Error('503');
    await expect(tryRead(Promise.reject(error))).resolves.toEqual({ ok: false, error });
  });

  it('notes a person-credential 401 on the call, because the handler will not rethrow it', async () => {
    const usage: CallUsage = { ivantiRequests: 0 };

    await withCallUsage(usage, () => tryRead(Promise.reject(refused('person'))));

    expect(usage.personRefused).toBe(true);
  });

  it('does not note the service key’s 401 or any other failure', async () => {
    const usage: CallUsage = { ivantiRequests: 0 };

    await withCallUsage(usage, async () => {
      await tryRead(Promise.reject(refused('service')));
      await tryRead(Promise.reject(new Error('503')));
    });

    expect(usage.personRefused).toBeUndefined();
  });

  it('tells a person-credential 401 from the service key’s', () => {
    expect(isPersonRefused(refused('person'))).toBe(true);
    expect(isPersonRefused(refused('service'))).toBe(false);
    expect(isPersonRefused(new Error('x'))).toBe(false);
  });
});

