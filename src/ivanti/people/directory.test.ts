// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { connectionFixture } from '../connection.fixture.js';
import { createPersonDirectory } from './directory.js';
import { UnknownEntityError } from '../metadata/catalog.js';
import { IvantiApiError } from '../http/errors.js';

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

/**
 * A failed lookup must not be memoised as "this tenant has no such object".
 *
 * `externalcontact` is absent from the seed graph, so resolving it is its own fetch. One 5xx used
 * to be caught into `undefined`, recorded in the permanent `present` list as absence, and never
 * retried — after which every external contact reads as "no such person" for the life of the
 * process. In `enduser` mode that means those people cannot use the server at all. The metadata
 * catalog already forgets retryable failures; memoising a list derived from one cancelled that.
 */
describe('personObjects', () => {
  /** A catalog whose `entity()` fails the first N times, then answers. */
  function flaky(failures: number, error: Error) {
    let seen = 0;
    return {
      entity: (name: string) => {
        if (name === 'employee') return Promise.resolve({ name: 'Employee' });
        seen += 1;
        return seen <= failures ? Promise.reject(error) : Promise.resolve({ name: 'ExternalContact' });
      },
      calls: () => seen,
    };
  }

  function directoryWith(catalog: { entity: (name: string) => Promise<unknown> }) {
    const { connection } = connectionFixture({ entities: { employee: {} } });
    return createPersonDirectory({
      transport: connection.transport,
      metadata: catalog as never,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
  }

  it('retries after a transport failure rather than recording absence', async () => {
    const catalog = flaky(1, new IvantiApiError({ status: 0, method: 'GET', url: 'x' }, 'timeout'));
    const directory = directoryWith(catalog);

    await expect(directory.personObjects()).rejects.toThrow();
    // The second call must actually ask again — the whole point.
    await expect(directory.personObjects()).resolves.toEqual(['employee', 'externalcontact']);
  });

  // The ordinary case, and the one the catch was written for: this tenant genuinely has no
  // `externalcontact`. That is absence, it is cached, and it must not become an error.
  it('still treats a genuinely unknown entity as absent, once', async () => {
    let asked = 0;
    const directory = directoryWith({
      entity: (name: string) => {
        if (name === 'employee') return Promise.resolve({ name: 'Employee' });
        asked += 1;
        return Promise.reject(new UnknownEntityError('externalcontact', []));
      },
    });

    await expect(directory.personObjects()).resolves.toEqual(['employee']);
    await expect(directory.personObjects()).resolves.toEqual(['employee']);
    expect(asked).toBe(1);
  });
});
