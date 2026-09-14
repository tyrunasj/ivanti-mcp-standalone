// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { entityFixture, field } from '../../ivanti/connection.fixture.js';
import { assertNullFilterTypes } from './null-filter.js';

const entity = entityFixture('change', {
  fields: [
    field('Owner'),
    { ...field('ScheduledStartDate'), type: 'Edm.DateTimeOffset' },
    { ...field('Sequence'), type: 'Edm.Int32' },
  ],
});

describe('assertNullFilterTypes', () => {
  it('allows $NULL on a text field, which is what it is for', () => {
    expect(() => assertNullFilterTypes("Owner eq '$NULL'", entity)).not.toThrow();
    expect(() => assertNullFilterTypes("Owner ne '$NULL'", entity)).not.toThrow();
  });

  it('refuses it on a date field, because Ivanti blames the field name instead', () => {
    // Measured: 400 ISM_4000 "No such entry exists" — which reads as a bad field name, and a
    // tester duly doubted a field `get_object_metadata` had confirmed one call earlier.
    expect(() => assertNullFilterTypes("ScheduledStartDate eq '$NULL'", entity)).toThrow(
      /only works on text fields/,
    );
    expect(() => assertNullFilterTypes("ScheduledStartDate eq '$NULL'", entity)).toThrow(
      /the field is fine, the operator is not/,
    );
  });

  it('refuses it on a numeric field too', () => {
    expect(() => assertNullFilterTypes("Sequence ne '$NULL'", entity)).toThrow(/Int32/);
  });

  it('leaves an unknown field to the tool that names it better', () => {
    expect(() => assertNullFilterTypes("Nope eq '$NULL'", entity)).not.toThrow();
  });

  it('ignores a filter that never mentions $NULL', () => {
    expect(() => assertNullFilterTypes("Owner eq 'JSmith'", entity)).not.toThrow();
    expect(() => assertNullFilterTypes(undefined, entity)).not.toThrow();
  });
});
