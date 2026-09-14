// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { assertSupportedFilter } from './filter.js';

/**
 * Ivanti refuses `$top` above 100 with a 400 that blames the "request payload" — measured live:
 * 100 returns 100 rows, 101 is an error. Paging with `$skip` works and does not repeat rows.
 */
export const MAX_TOP = 100;
export const DEFAULT_TOP = 25;

export interface OdataQuery {
  /** Ivanti's subset: eq/ne/gt/ge/lt/le/and/or only — checked by `assertSupportedFilter`. */
  filter?: string | undefined;
  /** `$search`: the only substring mechanism Ivanti honours. Case-insensitive, measured live. */
  search?: string | undefined;
  orderBy?: string | undefined;
  top?: number | undefined;
  skip?: number | undefined;
  /** Ivanti sends `@odata.count` unasked, but asking costs nothing and makes the intent clear. */
  count?: boolean | undefined;
}

/**
 * Builds the query string for a collection read.
 *
 * `$select` is deliberately absent: Ivanti answers a single-record GET carrying it with an empty
 * body, and blanks the values on saved searches. Projection happens client-side.
 *
 * `$expand` is absent for the same class of reason — under `rest_api_key` it is silently ignored,
 * so a caller would conclude "no related records" from a request that was never performed.
 */
export function buildQuery(query: OdataQuery): string {
  assertSupportedFilter(query.filter);

  const parts: string[] = [];
  const add = (key: string, value: string): void => {
    parts.push(`${key}=${encodeURIComponent(value)}`);
  };

  if (query.filter !== undefined && query.filter !== '') add('$filter', query.filter);
  if (query.search !== undefined && query.search !== '') add('$search', query.search);
  if (query.orderBy !== undefined && query.orderBy !== '') add('$orderby', query.orderBy);
  if (query.top !== undefined) add('$top', String(Math.min(Math.max(query.top, 1), MAX_TOP)));
  if (query.skip !== undefined && query.skip > 0) add('$skip', String(query.skip));
  if (query.count === true) add('$count', 'true');

  return parts.join('&');
}

/** Appends a query string to a route, if there is one. */
export function withQuery(url: string, query: string): string {
  return query === '' ? url : `${url}?${query}`;
}

/**
 * The total Ivanti reported alongside a page of rows, when it is trustworthy.
 *
 * A count smaller than the rows it arrived with is not a total — Ivanti has been seen to
 * contradict itself this way — so the caller is told the number is a floor rather than being
 * handed a wrong answer.
 */
export function readTotal(
  payload: unknown,
  rowCount: number,
): { total: number; exact: boolean } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;

  // OData permits the count as a number or as a numeric string, and Ivanti has been seen to
  // send it unasked — but anything else is not a count.
  const raw = (payload as Record<string, unknown>)['@odata.count'];
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;

  const total = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(total)) return undefined;

  return total < rowCount ? { total: rowCount, exact: false } : { total, exact: true };
}

/**
 * Quotes a value for an OData filter.
 *
 * A single quote ends the literal, so it is doubled — the OData escape. Without this, a login id
 * or subject carrying an apostrophe turns the rest of the filter into syntax, which Ivanti
 * reports as a bad request and a caller reads as "no such person".
 */
export function quoteOdataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
