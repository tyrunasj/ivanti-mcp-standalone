import { describe, expect, it } from 'vitest';
import { buildQuery, MAX_TOP, readTotal, withQuery } from './query.js';

describe('buildQuery', () => {
  it('encodes the options Ivanti honours', () => {
    const query = buildQuery({
      filter: "Status eq 'Active'",
      search: 'printer',
      orderBy: 'CreatedDateTime desc',
      top: 10,
      skip: 20,
      count: true,
    });

    expect(query).toBe(
      "$filter=Status%20eq%20'Active'&$search=printer&$orderby=CreatedDateTime%20desc&$top=10&$skip=20&$count=true",
    );
  });

  it('clamps top to the 100 Ivanti refuses to exceed', () => {
    expect(buildQuery({ top: 500 })).toBe(`$top=${String(MAX_TOP)}`);
    expect(buildQuery({ top: 0 })).toBe('$top=1');
  });

  it('omits what was not asked for, including a zero skip', () => {
    expect(buildQuery({ skip: 0, filter: '', search: '' })).toBe('');
  });

  it('refuses a filter Ivanti would silently ignore, before the request is made', () => {
    expect(() => buildQuery({ filter: "contains(Subject,'wifi')" })).toThrow(/silently ignored/);
  });
});

describe('withQuery', () => {
  it('leaves a bare URL alone', () => {
    expect(withQuery('https://t/Incidents', '')).toBe('https://t/Incidents');
    expect(withQuery('https://t/Incidents', '$top=1')).toBe('https://t/Incidents?$top=1');
  });
});

describe('readTotal', () => {
  it('reports a count that agrees with its rows as exact', () => {
    expect(readTotal({ '@odata.count': 545 }, 100)).toEqual({ total: 545, exact: true });
  });

  it('reports a count that contradicts its own rows as a floor', () => {
    // Reporting a floor as a total is the failure this shape exists to prevent.
    expect(readTotal({ '@odata.count': 3 }, 10)).toEqual({ total: 10, exact: false });
  });

  it('is undefined when Ivanti sent no count at all', () => {
    expect(readTotal({ value: [] }, 0)).toBeUndefined();
    expect(readTotal(undefined, 0)).toBeUndefined();
  });

  it('accepts a numeric string, which OData permits', () => {
    expect(readTotal({ '@odata.count': '42' }, 1)).toEqual({ total: 42, exact: true });
  });
});
