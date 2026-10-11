// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { IvantiApiError } from '../http/errors.js';
import type { IvantiTransport } from '../http/transport.js';
import { readRecordOrAbsent } from './read-record.js';

const failing = (status: number, body: string): IvantiTransport =>
  ({
    routes: { record: (set: string, id: string) => `https://t/${set}('${id}')` },
    request: vi.fn(() => Promise.reject(new IvantiApiError({ status, method: 'GET', url: 'u', body }))),
  }) as unknown as IvantiTransport;

const answering = (value: unknown): IvantiTransport =>
  ({
    routes: { record: (set: string, id: string) => `https://t/${set}('${id}')` },
    request: vi.fn(() => Promise.resolve(value)),
  }) as unknown as IvantiTransport;

describe('readRecordOrAbsent', () => {
  it('returns the record', async () => {
    await expect(readRecordOrAbsent(answering({ RecId: 'A' }), 'incidents', 'A')).resolves.toEqual({
      RecId: 'A',
    });
  });

  it('reads an empty body and Ivanti’s not-found dialect as absent', async () => {
    await expect(readRecordOrAbsent(answering(undefined), 'incidents', 'A')).resolves.toBeUndefined();
    await expect(
      readRecordOrAbsent(failing(400, 'Invalid key'), 'incidents', 'A'),
    ).resolves.toBeUndefined();
    await expect(readRecordOrAbsent(failing(404, ''), 'incidents', 'A')).resolves.toBeUndefined();
  });

  it.each([0, 500, 502, 504])('rethrows a %i rather than calling the record absent', async (status) => {
    await expect(readRecordOrAbsent(failing(status, 'boom'), 'incidents', 'A')).rejects.toMatchObject({
      status,
    });
  });
});
