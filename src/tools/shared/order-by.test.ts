import { describe, expect, it } from 'vitest';
import { entityFixture, field } from '../../ivanti/connection.fixture.js';
import { assertOrderBy } from './order-by.js';

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
});
