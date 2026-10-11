// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { referencedFieldNames } from '../../ivanti/odata/filter.js';
import type { EntityMetadata } from '../../ivanti/metadata/csdl.js';
import type { CallContext } from '../tool-definition.js';
import type { IvantiToolDeps } from './deps.js';
import { explainFieldError } from './explain-field-error.js';
import { assertNullFilterTypes } from './null-filter.js';
import { assertOrderBy } from './order-by.js';
import { requirePerson, scopeToOwnRecords, type ScopedRead } from './own-records.js';
import type { ResolvedObject } from './resolve-object.js';

/**
 * The checks every tool that takes a `filter` runs before it sends one.
 *
 * Ivanti answers a `$NULL` on a date and a mistyped field with the same "the field does not
 * exist", and an unknown sort field with an empty 204 — so each is refused locally, by name. They
 * lived at each call site, and the call sites drifted: `fulltext_search_object` ran one of them
 * and `group_count` another, so the same filter was explained by one tool and misreported by the
 * next. One function, so a tool that takes a filter cannot take only some of the checks.
 *
 * In order: who is asking (an unidentified caller is refused for that, not told which fields the
 * object has), the sort clause, the `$NULL` types, then the own-records narrowing, which also
 * refuses a filter the dialect cannot carry.
 */
export async function prepareFilterRead(
  deps: IvantiToolDeps,
  context: CallContext,
  resolved: ResolvedObject,
  query: { filter?: string | undefined; orderBy?: string | undefined },
): Promise<ScopedRead> {
  if (deps.ownRecordsOnly) requirePerson(context);
  assertOrderBy(query.orderBy, resolved.entity);
  assertNullFilterTypes(query.filter, resolved.entity);
  return scopeToOwnRecords(deps, context, resolved, query.filter);
}

/**
 * What to throw for a failed read: Ivanti's "No such entry exists" re-said with the field that was
 * wrong, or the error itself. For every `.catch` on a read that carries the caller's field names.
 */
export function explainReadError(
  error: unknown,
  entity: EntityMetadata,
  referenced: { filter?: string | undefined; fields?: readonly string[] | undefined },
): unknown {
  return explainFieldError(error, entity, referencedFieldNames(referenced)) ?? error;
}
