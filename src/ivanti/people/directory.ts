// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import type { IvantiTransport } from '../http/transport.js';
import { UnknownEntityError, type MetadataCatalog } from '../metadata/catalog.js';
import { toEntitySet } from '../metadata/entity-names.js';
import { buildQuery, quoteOdataString, withQuery } from '../odata/query.js';
import { readCollection, type OdataRecord } from '../odata/response.js';

/**
 * Turning "I am Harold Sanders" into an Ivanti person record.
 *
 * Three keys, measured on a live tenant: `LoginID`, `PrimaryEmail`, and `FirstName` + `LastName`.
 * Never `DisplayName` — it is assembled and carries the middle name ("John M Doe",
 * "Katherine M Joseph"), so the full name a person types for themselves routinely fails to equal
 * it. Match on the parts; show `DisplayName`.
 *
 * `IPCM_SearchableByName` looks exactly like the field that should gate this and is not: it
 * belongs to Ivanti Voice, and most tenants never populate it.
 */

/**
 * The objects a person can be, most likely first.
 *
 * Both carry all three keys on a stock tenant — `externalcontact` populates `LoginID` and
 * `PrimaryEmail` just as `employee` does. A tenant without `externalcontact` is ordinary, so a
 * missing object is skipped rather than failing the lookup.
 */
const PERSON_OBJECTS = ['employee', 'externalcontact'] as const;

/** Anything shorter is a fragment, not a claim, and would return most of the directory. */
export const MIN_CLAIM_LENGTH = 2;

/** How many rows Ivanti is asked for before the client-side filter runs. */
const SEARCH_FETCH = 25;

export type PersonMatchKey = 'LoginID' | 'PrimaryEmail' | 'name';

export interface PersonCandidate {
  recId: string;
  /** The CSDL object this person is: `employee` or `externalcontact`. */
  category: string;
  displayName: string;
  loginId?: string;
  primaryEmail?: string;
  /** `employee` has one; `externalcontact` has no such field at all. */
  status?: string;
  /**
   * Their department, when the record carries one.
   *
   * Worth returning because a service request routinely constrains a cascading answer on it —
   * a person asked to pick "the employee in your department" otherwise has no way to learn
   * which department that is, and the objects holding it are outside an end user's gate.
   */
  department?: string;
  /** Which key matched — shown when confirming, so a wrong-person match is visible. */
  matchedOn: PersonMatchKey;
}

export interface PersonDirectory {
  /**
   * Everyone the claim identifies. An exact hit on one of the three keys answers alone; only
   * when nothing is exact does the substring search run.
   */
  find: (claim: string) => Promise<PersonCandidate[]>;
  /** The CSDL names of the person objects this tenant actually has. */
  personObjects: () => Promise<string[]>;
}

export interface PersonDirectoryDeps {
  transport: IvantiTransport;
  metadata: MetadataCatalog;
  logger: Logger;
}

function text(row: OdataRecord, field: string): string | undefined {
  const value = row[field];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** `Sanders, Harold` and `Harold Sanders` are the same claim. */
function nameTokens(claim: string): string[] {
  const commaFirst = claim.includes(',')
    ? claim.split(',').reverse().join(' ')
    : claim;
  return commaFirst.split(/\s+/).filter((token) => token !== '');
}

/**
 * Every token the caller typed has to *be* one of the tokens on the record.
 *
 * Substring matching cannot do this job: Ivanti's keyword search answers `"John"` with John Smith,
 * John Davis, John M Doe **and Scott Johnson**, and "John" is a substring of "Johnson" as surely
 * as it is of "John". Whole-token equality drops the stranger and keeps "Katherine Joseph"
 * matching "Katherine M Joseph", because every token the caller gave is present.
 */
function claimMatchesRow(claim: string, row: OdataRecord): boolean {
  const wanted = nameTokens(claim).map((token) => token.toLowerCase());
  if (wanted.length === 0) return false;

  const login = text(row, 'LoginID')?.toLowerCase();
  const email = text(row, 'PrimaryEmail')?.toLowerCase();
  const whole = claim.trim().toLowerCase();
  if (whole === login || whole === email) return true;

  const available = new Set(
    ['FirstName', 'MiddleName', 'LastName', 'DisplayName']
      .flatMap((field) => nameTokens(text(row, field) ?? ''))
      .map((token) => token.toLowerCase()),
  );

  return wanted.every((token) => available.has(token));
}

function matchKey(claim: string, row: OdataRecord): PersonMatchKey {
  const whole = claim.trim().toLowerCase();
  if (text(row, 'LoginID')?.toLowerCase() === whole) return 'LoginID';
  if (text(row, 'PrimaryEmail')?.toLowerCase() === whole) return 'PrimaryEmail';
  return 'name';
}

function toCandidate(row: OdataRecord, object: string, claim: string): PersonCandidate | undefined {
  const recId = text(row, 'RecId');
  if (recId === undefined) return undefined;

  return {
    recId,
    category: object,
    displayName: text(row, 'DisplayName') ?? text(row, 'LoginID') ?? recId,
    ...(text(row, 'LoginID') === undefined ? {} : { loginId: text(row, 'LoginID') }),
    ...(text(row, 'PrimaryEmail') === undefined
      ? {}
      : { primaryEmail: text(row, 'PrimaryEmail') }),
    ...(text(row, 'Status') === undefined ? {} : { status: text(row, 'Status') }),
    ...(text(row, 'Department') === undefined ? {} : { department: text(row, 'Department') }),
    matchedOn: matchKey(claim, row),
  };
}

/**
 * The exact filter for a claim.
 *
 * `eq` is case-insensitive on Ivanti — `FirstName eq 'harold' and LastName eq 'SANDERS'` matches
 * Harold Sanders — so nothing is normalised on either side. A claim of two or more words also
 * tries first-and-last, taking the outermost tokens so a middle name does not break it.
 */
function exactFilter(claim: string): string {
  const value = quoteOdataString(claim.trim());
  const clauses = [`LoginID eq ${value}`, `PrimaryEmail eq ${value}`];

  const tokens = nameTokens(claim);
  if (tokens.length >= 2) {
    const first = quoteOdataString(tokens[0] ?? '');
    const last = quoteOdataString(tokens[tokens.length - 1] ?? '');
    clauses.push(`(FirstName eq ${first} and LastName eq ${last})`);
  }

  return clauses.join(' or ');
}

export function createPersonDirectory(deps: PersonDirectoryDeps): PersonDirectory {
  const { transport, metadata, logger } = deps;
  let present: Promise<string[]> | undefined;

  /**
   * Which person objects this tenant has. Asked once: the schema cannot change under us.
   *
   * "Absent" and "could not be reached" have to stay different, or the memo below turns one bad
   * second into a permanent fact. `externalcontact` is not in the seed graph, so resolving it is
   * its own fetch; a single 5xx on it used to be caught here, recorded as "this tenant has no
   * such object", and never retried — after which every external contact is "no such person" for
   * the life of the process, which in `enduser` mode means they cannot use the server at all.
   * The catalog already distinguishes the two cases and forgets the retryable ones; memoising a
   * list derived from a failure cancelled that.
   */
  const personObjects = async (): Promise<string[]> => {
    const resolve = async (): Promise<string[]> => {
      const found: string[] = [];
      for (const object of PERSON_OBJECTS) {
        // An absent object is the ordinary case for `externalcontact`, not a failure — but only
        // the catalog's own "this tenant does not have it" signal counts as absent. Anything
        // else propagates, so nothing is memoised and the next caller tries again.
        const entity = await metadata.entity(object).catch((error: unknown) => {
          if (error instanceof UnknownEntityError) return undefined;
          throw error;
        });
        if (entity !== undefined) found.push(entity.name.toLowerCase());
      }
      logger.debug('person objects', { objects: found });
      return found;
    };

    present ??= resolve().catch((error: unknown) => {
      present = undefined;
      throw error;
    });
    return present;
  };

  const read = async (object: string, query: string): Promise<OdataRecord[]> => {
    const url = withQuery(transport.routes.entitySet(toEntitySet(`${object}#`)), query);
    const payload = await transport.request<OdataRecord>(url);
    return readCollection<OdataRecord>(payload, url);
  };

  return {
    personObjects,

    async find(claim): Promise<PersonCandidate[]> {
      const trimmed = claim.trim();
      if (trimmed.length < MIN_CLAIM_LENGTH) return [];

      const objects = await personObjects();
      const exact: PersonCandidate[] = [];

      for (const object of objects) {
        const rows = await read(object, buildQuery({ filter: exactFilter(trimmed), top: 10 }));
        for (const row of rows) {
          // `exactFilter` takes the OUTERMOST tokens for its FirstName/LastName clause, so a
          // middle name does not break the match — but that also means "Mary Jane Watson" matches
          // **Mary Watson**, a different employee, exactly. An exact hit short-circuits the loose
          // search below, so nothing else would ever have looked at the token it dropped.
          //
          // A key match (LoginID, PrimaryEmail) is decisive on its own. A NAME match has to
          // account for every token the claim carried — which still matches "Katherine Joseph" to
          // "Katherine M Joseph", because every token given is present, and still refuses "Mary
          // Jane Watson" → "Mary Watson", because `jane` is not.
          if (matchKey(trimmed, row) === 'name' && !claimMatchesRow(trimmed, row)) continue;

          const candidate = toCandidate(row, object, trimmed);
          if (candidate !== undefined) exact.push(candidate);
        }
      }

      // An exact hit on a key answers on its own. Falling through to the substring search would
      // only add near-misses to a list that already has the right answer in it.
      if (exact.length > 0) return exact;

      const loose: PersonCandidate[] = [];
      for (const object of objects) {
        const rows = await read(object, buildQuery({ search: trimmed, top: SEARCH_FETCH }));
        for (const row of rows) {
          if (!claimMatchesRow(trimmed, row)) continue;
          const candidate = toCandidate(row, object, trimmed);
          if (candidate !== undefined) loose.push(candidate);
        }
      }

      return loose;
    },
  };
}
