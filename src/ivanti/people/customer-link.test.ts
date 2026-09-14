// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { connectionFixture, field } from '../connection.fixture.js';

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
