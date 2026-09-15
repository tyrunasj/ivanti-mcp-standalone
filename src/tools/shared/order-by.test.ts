// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { entityFixture, field } from '../../ivanti/connection.fixture.js';
import { assertFieldName, assertOrderBy } from './order-by.js';
import { FieldNameError } from './explain-field-error.js';

const entity = entityFixture('incident', {
  fields: [field('CreatedDateTime'), field('Subject'), field('Status')],
});

describe('assertOrderBy', () => {
  it('accepts every form Ivanti actually honours', () => {
    // All four verified live against `incidents`: bare field, either case of direction, and
    // several clauses separated by commas.
    for (const clause of [
      'CreatedDateTime',
      'CreatedDateTime asc',
      'CreatedDateTime DESC',
      'Subject asc, CreatedDateTime desc',
      undefined,
      '',
    ]) {
      expect(() => assertOrderBy(clause, entity)).not.toThrow();
    }
  });

  it('refuses an unknown field, because Ivanti answers 204 rather than an error', () => {
    // The measured case: one missing `Time` turned 548 incidents into zero rows, reported as
    // a successful empty result.
    expect(() => assertOrderBy('CreatedDate asc', entity)).toThrow(/no field named 'CreatedDate'/);
    expect(() => assertOrderBy('CreatedDate asc', entity)).toThrow(/CreatedDateTime/);
    expect(() => assertOrderBy('CreatedDate asc', entity)).toThrow(/NO ROWS rather than an error/);
  });

  it('refuses an unknown field in the second clause too', () => {
    expect(() => assertOrderBy('Subject asc, Nope desc', entity)).toThrow(/'Nope'/);
  });

  it('refuses a direction Ivanti does not understand — also a 204', () => {
    expect(() => assertOrderBy('CreatedDateTime sideways', entity)).toThrow(
      /not a valid sort clause/,
    );
  });

  /**
   * A stray comma is not a sort clause.
   *
   * Empty clauses used to be skipped, and both callers send the caller's RAW string rather than a
   * re-join of what was validated — so `Priority asc,` reached Ivanti unchecked. Whatever Ivanti
   * makes of it, the tools then report the result under zeroNote's "the field and sort names were
   * checked against the object before the request", which this function had not done.
   */
  it.each([
    ['a trailing comma', 'Status desc,'],
    ['a leading comma', ', Status desc'],
    ['a doubled comma', 'Status desc,,Subject asc'],
    ['nothing but a comma', ','],
  ])('refuses %s', (_label, orderBy) => {
    expect(() => assertOrderBy(orderBy, entity)).toThrow(FieldNameError);
  });

  it('still accepts the ordinary multi-clause sort', () => {
    expect(() => assertOrderBy('Status desc, Subject asc', entity)).not.toThrow();
  });
});

/**
 * `group_count` puts `groupBy` in a filter as a FIELD NAME — the value beside it is quoted, the
 * name is not — and the pick-list walk that would otherwise reject an unknown name is skipped
 * whenever the caller supplies `values`. So the name has to be checked here.
 */
describe('assertFieldName', () => {
  it('accepts a field the object has, whatever the casing', () => {
    expect(() => assertFieldName('status', entity, 'groupBy')).not.toThrow();
  });

  it('refuses a field the object does not have, and suggests', () => {
    expect(() => assertFieldName('Statuss', entity, 'groupBy')).toThrow(/Status/);
  });

  // The reason it exists: an unquoted name is a way to write OData into the clause, and `and`
  // binds tighter than `or`, so a trailing disjunct escapes the own-records constraint.
  it.each([
    ["Status ne 'zzz' or Status",
     'a disjunct that ORs the scope away'],
    ["Subject eq 'guess' or Status", 'an equality oracle over other people’s records'],
    ['Status desc', 'anything with a space in it'],
  ])('refuses %s — %s', (injected) => {
    expect(() => assertFieldName(injected, entity, 'groupBy')).toThrow(FieldNameError);
  });

  // An entity with no field metadata is a narrow fixture, not a tenant: refusing every name there
  // would be inventing an answer we do not have.
  it('says nothing when the object declares no fields', () => {
    expect(() =>
      assertFieldName('Anything', { name: 'x', fields: [], relationships: [] }, 'groupBy'),
    ).not.toThrow();
  });
});

