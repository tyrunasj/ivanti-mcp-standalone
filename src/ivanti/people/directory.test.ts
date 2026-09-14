// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { connectionFixture } from '../connection.fixture.js';

/** The four rows Ivanti really answers `search: "John"` with on the staging tenant. */
const JOHN_SEARCH = {
  value: [
    { RecId: 'a', DisplayName: 'John Smith', FirstName: 'John', LastName: 'Smith', LoginID: 'john' },
    { RecId: 'b', DisplayName: 'John Davis', FirstName: 'John', LastName: 'Davis', LoginID: 'JDavis' },
    {
      RecId: 'c',
      DisplayName: 'John M Doe',
      FirstName: 'John',
      MiddleName: 'M',
      LastName: 'Doe',
      LoginID: 'JDoe',
    },
    // Ivanti's keyword search is a substring match, so "John" reaches "Johnson".
    {
      RecId: 'd',
      DisplayName: 'Scott Johnson',
      FirstName: 'Scott',
      LastName: 'Johnson',
      LoginID: 'SJohnson',
    },
  ],
};

const directoryOf = (
  responses: Record<string, unknown>,
  entities: Record<string, object> = { employee: {} },
) => connectionFixture({ entities, responses }).connection.people.directory;

describe('createPersonDirectory', () => {
  it('answers an exact key match without running the substring search', async () => {
    const { connection, urls } = connectionFixture({
      entities: { employee: {} },
      responses: {
        '$filter': {
          value: [
            {
              RecId: 'e1',
              DisplayName: 'Harold Sanders',
              LoginID: 'HSanders',
              PrimaryEmail: 'HSanders@saasitdemo.com',
              Status: 'Active',
            },
          ],
        },
      },
    });

    const found = await connection.people.directory.find('HSanders');

    expect(found).toHaveLength(1);
    expect(found[0]?.displayName).toBe('Harold Sanders');
    expect(found[0]?.matchedOn).toBe('LoginID');
    // An exact hit is the answer: falling through to the search would only add near misses to a
    // list that already contains the right person.
    expect(urls.filter((url) => url.includes('$search'))).toEqual([]);
  });

  it('drops the substring match that is not actually the person', async () => {
    // This is the whole reason the re-filter exists: Scott Johnson comes back from Ivanti and
    // must not be offered as a candidate for "John".
    const directory = directoryOf({ $search: JOHN_SEARCH });

    const found = await directory.find('John');

    expect(found.map((person) => person.displayName)).toEqual([
      'John Smith',
      'John Davis',
      'John M Doe',
    ]);
  });

  it('matches a full name against a display name carrying a middle name', async () => {
    const directory = directoryOf({
      $search: {
        value: [
          {
            RecId: 'k',
            DisplayName: 'Katherine M Joseph',
            FirstName: 'Katherine',
            MiddleName: 'M',
            LastName: 'Joseph',
          },
        ],
      },
    });

    // Nobody types their own middle initial, and `DisplayName` has one.
    expect(await directory.find('Katherine Joseph')).toHaveLength(1);
  });

  it('reads "Sanders, Harold" as the same claim as "Harold Sanders"', async () => {
    const directory = directoryOf({
      $search: {
        value: [
          { RecId: 'h', DisplayName: 'Harold Sanders', FirstName: 'Harold', LastName: 'Sanders' },
        ],
      },
    });

    expect(await directory.find('Sanders, Harold')).toHaveLength(1);
  });

  it('refuses a fragment too short to mean anyone', async () => {
    const directory = directoryOf({ $search: JOHN_SEARCH });

    expect(await directory.find('J')).toEqual([]);
  });

  it('searches external contacts as well, and says which object each person is', async () => {
    const directory = directoryOf(
      {
        externalcontacts: {
          value: [{ RecId: 'x1', DisplayName: 'James Keith', FirstName: 'James', LastName: 'Keith' }],
        },
        employees: { value: [] },
      },
      { employee: {}, externalcontact: {} },
    );

    const found = await directory.find('James Keith');

    expect(found).toHaveLength(1);
    expect(found[0]?.category).toBe('externalcontact');
  });

  it('skips a person object the tenant does not have', async () => {
    // `externalcontact` is optional, and its absence is ordinary rather than a failure.
    const directory = directoryOf({ $search: JOHN_SEARCH }, { employee: {} });

    expect(await directory.personObjects()).toEqual(['employee']);
  });
});
