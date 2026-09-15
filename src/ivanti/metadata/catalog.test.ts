// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import { IvantiApiError } from '../http/errors.js';
import type { IvantiTransport } from '../http/transport.js';
import { createIvantiRoutes } from '../odata/url.js';
import { createMetadataCatalog, UnknownEntityError } from './catalog.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const entity = (name: string, relationships = ''): string =>
  `<EntityType Name="${name}"><Property Name="RecId" Type="Edm.String" />${relationships}</EntityType>`;

const csdl = (...types: string[]): string =>
  `<?xml version="1.0"?><edmx:Edmx Version="4.0"><edmx:DataServices><Schema Namespace="MetaData">${types.join('')}</Schema></edmx:DataServices></edmx:Edmx>`;

const NAV = '<NavigationProperty Name="IncidentContainsTask" Type="Collection(MetaData.task)" />';

const SEED_URL = 'https://t/HEAT/api/odata/incidents/$metadata';

/** Answers `requestText` from a fragment→body map; anything unmatched is a 404. */
function fakeTransport(documents: Record<string, string | Error>): {
  transport: IvantiTransport;
  calls: string[];
} {
  const calls: string[] = [];
  const transport: IvantiTransport = {
    routes: createIvantiRoutes('https://t', '/HEAT'),
    // A fixture serves one credential; impersonation is exercised where it is implemented.
    asPerson: (): never => {
      throw new Error('this fixture has no impersonated transport');
    },
    request: () => Promise.resolve(undefined),
    requestRequired: () => Promise.reject(new Error('unused')),
    requestMultipart: () => Promise.reject(new Error('unused')),
    requestBinary: () => Promise.reject(new Error('unused')),
    requestText: (url: string) => {
      calls.push(url);
      const match = Object.entries(documents).find(([fragment]) => url.includes(fragment));
      if (match === undefined) {
        return Promise.reject(
          new IvantiApiError({ status: 404, method: 'GET', url, body: 'no such thing' }),
        );
      }
      const body = match[1];
      return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
    },
  };
  return { transport, calls };
}

const catalog = (documents: Record<string, string | Error>) => {
  const { transport, calls } = fakeTransport(documents);
  return {
    calls,
    catalog: createMetadataCatalog({ transport, seedUrl: SEED_URL, logger: logger() }),
  };
};

describe('createMetadataCatalog', () => {
  it('answers from the seed graph when it carries relationships', async () => {
    const { catalog: metadata, calls } = catalog({
      '/incidents/$metadata': csdl(entity('incident', NAV), entity('task')),
    });

    const incident = await metadata.entity('Incident#');

    expect(incident.relationships).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("fetches the entity's own graph when the shared one reports no relationships", async () => {
    // Measured live: in the incidents graph, task is 90 fields / 0 relationships; in its own
    // graph it is 90 fields / 29 relationships.
    const { catalog: metadata, calls } = catalog({
      '/incidents/$metadata': csdl(entity('incident', NAV), entity('task')),
      '/tasks/$metadata': csdl(entity('task', NAV)),
    });

    const task = await metadata.entity('Task#');

    expect(task.relationships).toHaveLength(1);
    expect(calls).toEqual([SEED_URL, 'https://t/HEAT/api/odata/tasks/$metadata']);
  });

  it('falls back to the shared graph when the entity genuinely has no relationships', async () => {
    const { catalog: metadata } = catalog({
      '/incidents/$metadata': csdl(entity('incident', NAV), entity('task')),
      // tasks/$metadata is a 404 here
    });

    await expect(metadata.entity('Task#')).resolves.toMatchObject({
      name: 'task',
      relationships: [],
    });
  });

  it('finds an entity the seed graph never names', async () => {
    const { catalog: metadata } = catalog({
      '/incidents/$metadata': csdl(entity('incident', NAV)),
      '/employees/$metadata': csdl(entity('employee', NAV)),
    });

    await expect(metadata.entity('Employee#')).resolves.toMatchObject({ name: 'employee' });
  });

  it('reports an English plural as a naming error with suggestions, not as zero rows', async () => {
    const { catalog: metadata } = catalog({
      '/incidents/$metadata': csdl(entity('incident', NAV), entity('category')),
    });

    await expect(metadata.entity('Categories')).rejects.toThrow(UnknownEntityError);
    await expect(metadata.entity('Categories')).rejects.toThrow(/Did you mean: category\?/);
  });

  it('caches a mistyped entity, so the typo costs one round trip and not one per call', async () => {
    const { catalog: metadata, calls } = catalog({
      '/incidents/$metadata': csdl(entity('incident', NAV)),
    });

    await metadata.entity('Nonexistent#').catch(() => undefined);
    await metadata.entity('Nonexistent#').catch(() => undefined);

    expect(calls.filter((url) => url.includes('nonexistents'))).toHaveLength(1);
  });

  it('never caches a non-CSDL 200 as metadata', async () => {
    const { catalog: metadata } = catalog({
      '/incidents/$metadata': '<html><body>Sign in</body></html>',
      '/tasks/$metadata': csdl(entity('task', NAV)),
    });

    // The login page must not become "the schema" — task is still findable through its own graph.
    await expect(metadata.entity('Task#')).resolves.toMatchObject({ name: 'task' });
  });

  it('retries after a connection failure rather than staying blind for the process lifetime', async () => {
    const flaky = new IvantiApiError(
      { status: 0, method: 'GET', url: SEED_URL, body: 'ECONNRESET' },
      'did not complete',
    );
    const documents: Record<string, string | Error> = { '/incidents/$metadata': flaky };
    const { transport, calls } = fakeTransport(documents);
    const metadata = createMetadataCatalog({ transport, seedUrl: SEED_URL, logger: logger() });

    await metadata.entity('Incident#').catch(() => undefined);
    documents['/incidents/$metadata'] = csdl(entity('incident', NAV));

    await expect(metadata.entity('Incident#')).resolves.toMatchObject({ name: 'incident' });
    // The point is that the failure was not cached: the URL was asked for again.
    expect(calls.filter((url) => url === SEED_URL).length).toBeGreaterThan(1);
  });

  it('widens the catalog as more graphs are parsed', async () => {
    const { catalog: metadata } = catalog({
      '/incidents/$metadata': csdl(entity('incident', NAV), entity('task')),
      '/employees/$metadata': csdl(entity('employee', NAV), entity('team')),
    });

    await expect(metadata.entityNames()).resolves.toEqual(['incident', 'task']);
    await metadata.graph('employees');
    await expect(metadata.entityNames()).resolves.toEqual([
      'employee',
      'incident',
      'task',
      'team',
    ]);
  });

  it('says so plainly when $metadata cannot be read at all', async () => {
    const { catalog: metadata } = catalog({});

    await expect(metadata.entityNames()).rejects.toThrow(/could not be read/);
  });

  it('suggests from the wider catalog when the credential can see it', async () => {
    const { transport } = fakeTransport({ '/incidents/$metadata': csdl(entity('incident', NAV)) });
    const metadata = createMetadataCatalog({
      transport,
      seedUrl: SEED_URL,
      logger: logger(),
      // What the admin console knows, which the metadata graphs do not.
      suggestionNames: () => Promise.resolve(['xlj_car', 'onboardingrequest']),
    });

    // The object is in the admin console's catalog but in none of the graphs fetched here.
    await expect(metadata.entity('OnboardingReq')).rejects.toThrow(/onboardingrequest/);
  });

  it('still answers when the wider catalog fails', async () => {
    const { transport } = fakeTransport({ '/incidents/$metadata': csdl(entity('incident', NAV)) });
    const metadata = createMetadataCatalog({
      transport,
      seedUrl: SEED_URL,
      logger: logger(),
      suggestionNames: () => Promise.reject(new Error('403')),
    });

    await expect(metadata.entity('Nonsense')).rejects.toThrow(UnknownEntityError);
  });

  /**
   * A bad moment must not become a permanent fact.
   *
   * The eviction test was `status === 0` alone, so every 5xx, every 401/403/429 and anything that
   * was not an `IvantiApiError` at all was cached as "this entity does not exist" with no TTL.
   * One app-pool recycle and the process answers "Ivanti has no Business Object named 'Incident#'"
   * for the rest of its life, making no further request. Because the seed graph's URL is
   * byte-identical to the startup probe's, poisoning it kills the most-used object of all.
   */
  describe('which failures are remembered', () => {
    /** Fails every request while `down` is true, then serves a real document. */
    function flaky(error: Error) {
      let down = true;
      const { transport, calls } = fakeTransport({});
      const failing: IvantiTransport = {
        ...transport,
        requestText: (url: string) => {
          calls.push(url);
          return down
            ? Promise.reject(error)
            : Promise.resolve(csdl(entity('incident', NAV), entity('task')));
        },
      };
      return {
        catalog: createMetadataCatalog({ transport: failing, seedUrl: SEED_URL, logger: logger() }),
        calls,
        recover: () => {
          down = false;
        },
      };
    }

    it.each([
      ['a 503 while the tenant recycles', new IvantiApiError({ status: 503, method: 'GET', url: SEED_URL }, 'unavailable')],
      ['a 429', new IvantiApiError({ status: 429, method: 'GET', url: SEED_URL }, 'slow down')],
      ['a 401 from a proxy', new IvantiApiError({ status: 401, method: 'GET', url: SEED_URL }, 'nope')],
      ['a transport failure', new IvantiApiError({ status: 0, method: 'GET', url: SEED_URL }, 'timeout')],
      ['something that is not an IvantiApiError at all', new TypeError('terminated')],
    ])('tries again after %s', async (_label, error) => {
      const { catalog: subject, recover } = flaky(error);

      await expect(subject.entity('incident')).rejects.toThrow(UnknownEntityError);

      // Ivanti recovers a second later. Nothing about the first failure may outlive it.
      recover();
      await expect(subject.entity('incident')).resolves.toMatchObject({ name: 'incident' });
    });

    // The other direction, and the reason the cache exists: Ivanti answering 200 with its
    // fabricated field-less document is a real "no such entity", and a mistyped name must cost
    // one round trip rather than one per call.
    it('keeps caching a definitive answer, so a typo is not re-asked', async () => {
      // Ivanti's fabricated answer for an unknown entity set: valid CSDL, field-less type.
      const { catalog: subject, calls } = catalog({
        '/incidents/$metadata': csdl(entity('incident', NAV)),
        '/nonexistents/$metadata': csdl('<EntityType Name="nonexistent" />'),
      });

      await expect(subject.entity('nonexistent')).rejects.toThrow(UnknownEntityError);
      const afterFirst = calls.length;
      await expect(subject.entity('nonexistent')).rejects.toThrow(UnknownEntityError);

      expect(calls.length).toBe(afterFirst);
    });
  });
});

