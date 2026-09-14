// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import type { IvantiTransport } from '../http/transport.js';
import type { EntityMetadata } from '../metadata/csdl.js';
import { buildQuery, withQuery } from '../odata/query.js';
import { readCollection, type OdataRecord } from '../odata/response.js';

/**
 * Which field on a record holds the person it belongs to.
 *
 * It is **not** the same field on every object, and the B5 lesson applies exactly: measured on a
 * live tenant, an incident stores its customer in `ProfileLink_RecID`, a service request in
 * `ProfileLink_RecID` *and* has a second person link in `AlternateContactLink_RecID`, and a
 * change has no `ProfileLink` at all — it uses `RequestorLink_RecID`. Hard-coding any one of them
 * scopes the wrong object to nothing, or worse, to everything.
 *
 * So it is discovered from the tenant's own data: sample a few records and see which link field
 * actually points at a person object. On this tenant that answers `RequestorLink` for a change
 * (51 of 51 rows) and prefers `ProfileLink` over `AlternateContactLink` for a service request
 * without needing a rule, because the alternate contact is null on every row.
 */

export interface CustomerLink {
  /** The field holding the person's RecId — `ProfileLink_RecID`, `RequestorLink_RecID`. */
  readonly recIdField: string;
  /** Its twin, naming which object the person is. */
  readonly categoryField: string;
  /** Whether the tenant's data decided this, or only the field's name did. */
  readonly foundBy: 'data' | 'name';
  /**
   * The category values actually seen in this field — `Employee`, not `employee`.
   *
   * CSDL reports entity names lowercase while records store them mixed-case, and a write has to
   * use the tenant's own spelling. Reading it off real rows avoids guessing at the casing.
   */
  readonly categoriesSeen: readonly string[];
  /** More than one link field points at people, and the runner-up was not empty. */
  readonly ambiguous: boolean;
}

export interface CustomerLinks {
  /** Undefined when this object has no person link — the caller must then refuse, not guess. */
  forEntity: (entity: EntityMetadata, entitySet: string) => Promise<CustomerLink | undefined>;
}

export interface CustomerLinksDeps {
  transport: IvantiTransport;
  /** The CSDL names of the objects a person can be, from the person directory. */
  personObjects: () => Promise<string[]>;
  logger: Logger;
}

/**
 * Enough rows to see which link is populated, few enough not to pay for it.
 *
 * `$select` does not exist here (Ivanti answers a single-record GET carrying it with an empty
 * body), so every sampled row arrives whole. None of it reaches the model: only the `*_Category`
 * values are read, and the result is cached for the life of the process.
 */
const SAMPLE_ROWS = 10;

/**
 * Used only to break a tie, and as the last resort on an object with no records yet.
 *
 * Deliberately not the primary mechanism: a name ladder is what would have answered `ProfileLink`
 * for a change, which does not have one.
 */
const PREFERRED = ['profilelink', 'requestorlink', 'customerlink', 'contactlink'];

interface Candidate {
  recIdField: string;
  categoryField: string;
  prefix: string;
}

/** The `X_RecID` / `X_Category` pairs on an object, which is what a link is made of. */
function candidatesOf(entity: EntityMetadata): Candidate[] {
  const byLower = new Map(entity.fields.map((field) => [field.name.toLowerCase(), field.name]));
  const pairs: Candidate[] = [];

  for (const field of entity.fields) {
    const match = /^(.*)_Category$/i.exec(field.name);
    const prefix = match?.[1];
    if (prefix === undefined || prefix === '') continue;

    // Ivanti writes `_RecID`, but nothing guarantees the casing, so the lookup is case-folded.
    const recIdField = byLower.get(`${prefix.toLowerCase()}_recid`);
    if (recIdField === undefined) continue;

    pairs.push({ recIdField, categoryField: field.name, prefix: prefix.toLowerCase() });
  }

  return pairs;
}

function rank(prefix: string): number {
  const index = PREFERRED.indexOf(prefix);
  return index === -1 ? PREFERRED.length : index;
}

export function createCustomerLinks(deps: CustomerLinksDeps): CustomerLinks {
  const { transport, personObjects, logger } = deps;
  const cache = new Map<string, Promise<CustomerLink | undefined>>();

  const discover = async (
    entity: EntityMetadata,
    entitySet: string,
  ): Promise<CustomerLink | undefined> => {
    const candidates = candidatesOf(entity);
    if (candidates.length === 0) return undefined;

    const people = new Set((await personObjects()).map((name) => name.toLowerCase()));

    const url = withQuery(transport.routes.entitySet(entitySet), buildQuery({ top: SAMPLE_ROWS }));
    const rows = await transport
      .request<OdataRecord>(url)
      .then((payload) => readCollection<OdataRecord>(payload, url))
      // A sampling failure must not take the tool down with it: fall through to the name ladder.
      .catch((error: unknown) => {
        logger.debug('customer link sampling failed', {
          entity: entity.name,
          error: error instanceof Error ? error.message : 'unknown error',
        });
        return [] as OdataRecord[];
      });

    const scored = candidates
      .map((candidate) => {
        const seen = rows
          .map((row) => row[candidate.categoryField])
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter((value) => people.has(value.toLowerCase()));
        return { candidate, hits: seen.length, categoriesSeen: [...new Set(seen)] };
      })
      .filter((entry) => entry.hits > 0)
      .sort((a, b) => b.hits - a.hits || rank(a.candidate.prefix) - rank(b.candidate.prefix));

    const best = scored[0];
    if (best !== undefined) {
      const runnerUp = scored[1];
      return {
        recIdField: best.candidate.recIdField,
        categoryField: best.candidate.categoryField,
        foundBy: 'data',
        ambiguous: runnerUp !== undefined && runnerUp.hits === best.hits,
        categoriesSeen: best.categoriesSeen,
      };
    }

    // No records yet, or nobody is linked on any of them. The name is all that is left.
    const named = candidates
      .filter((candidate) => PREFERRED.includes(candidate.prefix))
      .sort((a, b) => rank(a.prefix) - rank(b.prefix))[0];

    if (named === undefined) return undefined;

    return {
      recIdField: named.recIdField,
      categoryField: named.categoryField,
      foundBy: 'name',
      ambiguous: false,
      categoriesSeen: [],
    };
  };

  return {
    forEntity(entity, entitySet): Promise<CustomerLink | undefined> {
      const key = entity.name.toLowerCase();
      let found = cache.get(key);
      if (found === undefined) {
        found = discover(entity, entitySet);
        cache.set(key, found);
      }
      return found;
    },
  };
}
