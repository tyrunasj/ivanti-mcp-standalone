// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { connectionFixture, entityFixture, field } from '../connection.fixture.js';
import { createCustomerLinks } from './customer-link.js';

const linkFields = (...prefixes: string[]) => [
  field('RecId'),
  ...prefixes.flatMap((prefix) => [field(`${prefix}_RecID`), field(`${prefix}_Category`)]),
];

async function linkFor(
  entityName: string,
  fields: ReturnType<typeof linkFields>,
  rows: Record<string, unknown>[],
) {
  const { connection } = connectionFixture({
    entities: { [entityName]: { fields }, employee: {} },
    responses: { [`${entityName}s`]: { value: rows }, employees: { value: [] } },
  });
  const entity = await connection.metadata.entity(entityName);
  return connection.people.customerLinks.forEntity(entity, `${entityName}s`);
}

describe('createCustomerLinks', () => {
  it('finds the link the tenant actually uses, not the one with the familiar name', async () => {
    // Measured live: a change has no `ProfileLink` at all. A name ladder would answer nothing
    // here, or worse, the first link it recognised.
    const link = await linkFor(
      'change',
      linkFields('ParentLink', 'RequestorLink'),
      [
        { RecId: 'c1', RequestorLink_RecID: 'e1', RequestorLink_Category: 'Employee', ParentLink_Category: '' },
        { RecId: 'c2', RequestorLink_RecID: 'e2', RequestorLink_Category: 'Employee', ParentLink_Category: null },
      ],
    );

    expect(link?.recIdField).toBe('RequestorLink_RecID');
    expect(link?.categoryField).toBe('RequestorLink_Category');
    expect(link?.foundBy).toBe('data');
  });

  it('prefers the populated person link over the empty one', async () => {
    // A service request has two person links; on a real tenant the alternate contact is null on
    // every row, so the data decides without needing a rule.
    const link = await linkFor(
      'servicereq',
      linkFields('ProfileLink', 'AlternateContactLink'),
      [
        {
          RecId: 's1',
          ProfileLink_RecID: 'e1',
          ProfileLink_Category: 'Employee',
          AlternateContactLink_Category: null,
        },
      ],
    );

    expect(link?.recIdField).toBe('ProfileLink_RecID');
    expect(link?.ambiguous).toBe(false);
  });

  it('keeps the tenant’s own spelling of the category', async () => {
    // CSDL reports `employee`; records store `Employee`, and a write has to use the latter.
    const link = await linkFor('incident', linkFields('ProfileLink'), [
      { RecId: 'i1', ProfileLink_RecID: 'e1', ProfileLink_Category: 'Employee' },
    ]);

    expect(link?.categoriesSeen).toEqual(['Employee']);
  });

  it('says so when more than one link points at people just as often', async () => {
    const link = await linkFor('hrcase', linkFields('SubjectLink', 'ReporterLink'), [
      {
        RecId: 'h1',
        SubjectLink_RecID: 'e1',
        SubjectLink_Category: 'Employee',
        ReporterLink_RecID: 'e2',
        ReporterLink_Category: 'Employee',
      },
    ]);

    expect(link?.ambiguous).toBe(true);
  });

  it('falls back to the name when the object has no records to learn from', async () => {
    const link = await linkFor('incident', linkFields('ProfileLink', 'OwnerLink'), []);

    expect(link?.recIdField).toBe('ProfileLink_RecID');
    expect(link?.foundBy).toBe('name');
  });

  it('answers nothing when no field ties a record to a person', async () => {
    // The caller must then refuse rather than fall back to an unscoped read.
    const link = await linkFor('category', [field('RecId'), field('Name')], [{ RecId: 'k1' }]);

    expect(link).toBeUndefined();
  });
});

/**
 * A guess made because the sample FAILED is not a fact about the tenant.
 *
 * A sampling error and a genuinely empty table are the same shape — no rows — and lead to the same
 * fallback, the name ladder. But the answer is cached for the process lifetime, so one bad second
 * fixed a guessed link field permanently, behind a `logger.debug` line the default LOG_LEVEL hides.
 */
describe('a sample that failed is not remembered', () => {
  const entity = entityFixture('incident', {
    fields: [field('RecId'), field('ProfileLink_RecID'), field('ProfileLink_Category')],
  });

  /** A transport whose sampling read fails `failures` times, then answers with real rows. */
  function flaky(failures: number) {
    let seen = 0;
    const rows = { value: [{ ProfileLink_RecID: 'e1', ProfileLink_Category: 'Employee' }] };
    const { connection } = connectionFixture({ entities: { incident: {}, employee: {} } });
    const transport = {
      ...connection.transport,
      request: (url: string) => {
        if (!url.includes('incidents')) return Promise.resolve({ value: [] });
        seen += 1;
        return seen <= failures
          ? Promise.reject(new Error('Ivanti 500'))
          : Promise.resolve(rows);
      },
    } as typeof connection.transport;

    return {
      links: createCustomerLinks({
        transport,
        personObjects: () => Promise.resolve(['employee']),
        logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
      reads: () => seen,
    };
  }

  it('samples again on the next call', async () => {
    const { links, reads } = flaky(1);

    const guessed = await links.forEntity(entity, 'incidents');
    const measured = await links.forEntity(entity, 'incidents');

    expect(guessed?.foundBy).toBe('name');
    expect(measured?.foundBy).toBe('data');
    // And the casing the tenant actually stores, which the guess could not know.
    expect(measured?.categoriesSeen).toEqual(['Employee']);
    expect(reads()).toBe(2);
  });

  // The other direction, and why the cache exists: an answer that really was derived from the
  // data is asked for once, not once per record operation.
  it('still remembers an answer the sample actually produced', async () => {
    const { links, reads } = flaky(0);

    await links.forEntity(entity, 'incidents');
    await links.forEntity(entity, 'incidents');

    expect(reads()).toBe(1);
  });
});

