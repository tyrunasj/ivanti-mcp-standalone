// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../connection.fixture.js';
import type { Logger } from '../../logger.js';
import { createTenantOffsetReader } from './tenant-offset.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function reader(responses: Record<string, unknown>) {
  const { connection, urls } = connectionFixture({ responses });
  return { urls, offset: createTenantOffsetReader(connection.transport, logger()) };
}

describe('createTenantOffsetReader', () => {
  it('reads the offset off the NEWEST row, because an old one may be a clock change behind', async () => {
    const { offset, urls } = reader({
      servicereqs: { value: [{ RecId: 'sr1', LastModDateTime: '2026-09-28T10:00:00+02:00' }] },
    });

    expect(await offset.get()).toEqual({
      minutes: 120,
      observedAt: '2026-09-28T10:00:00+02:00',
    });
    expect(urls[0]).toContain('$orderby=LastModDateTime%20desc');
    expect(urls[0]).toContain('$top=1');
  });

  it.each([
    ['-05:00', -300],
    ['+05:30', 330],
    ['+00:00', 0],
  ])('reads %s as %i minutes east of UTC', async (suffix, minutes) => {
    const { offset } = reader({
      servicereqs: { value: [{ CreatedDateTime: `2026-09-28T10:00:00${suffix}` }] },
    });

    expect((await offset.get())?.minutes).toBe(minutes);
  });

  it('skips values that carry no offset and finds one that does', async () => {
    const { offset } = reader({
      servicereqs: {
        value: [{ RecId: 'sr1', Count: 3, Subject: 'Laptop', LastModDateTime: '2026-01-15T09:00:00+01:00' }],
      },
    });

    expect((await offset.get())?.minutes).toBe(60);
  });

  it('asks the next object when the first cannot be read', async () => {
    const { offset, urls } = reader({
      servicereqs: new Error('Ivanti 500'),
      incidents: { value: [{ LastModDateTime: '2026-09-28T10:00:00+03:00' }] },
    });

    expect((await offset.get())?.minutes).toBe(180);
    expect(urls.map((url) => url.replace(/^GET .*businessobject\//, '').split('?')[0])).toEqual([
      'servicereqs',
      'incidents',
    ]);
  });

  it('asks the next object when the first has no rows, or none with a timestamp', async () => {
    const { offset } = reader({
      servicereqs: { value: [] },
      incidents: { value: [{ RecId: 'i1', Subject: 'no dates here' }] },
      employees: { value: [{ LastModDateTime: '2026-09-28T10:00:00-04:00' }] },
    });

    expect((await offset.get())?.minutes).toBe(-240);
  });

  it('answers undefined when no source has a timestamp — the caller must say so, not assume 0', async () => {
    const { offset } = reader({
      servicereqs: new Error('Ivanti 500'),
      incidents: { value: [] },
      employees: { value: [{ LastModDateTime: '2026-09-28T10:00:00Z' }] },
    });

    expect(await offset.get()).toBeUndefined();
  });

  it('looks once and remembers the answer', async () => {
    const { offset, urls } = reader({
      servicereqs: { value: [{ LastModDateTime: '2026-09-28T10:00:00+02:00' }] },
    });

    await offset.get();
    await offset.get();

    expect(urls).toHaveLength(1);
  });
});
