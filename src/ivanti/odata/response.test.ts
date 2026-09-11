import { describe, expect, it } from 'vitest';
import { IvantiApiError } from '../http/errors.js';
import { readCollection } from './response.js';

const URL = 'https://t/HEAT/api/odata/businessobject/Incidents';

describe('readCollection', () => {
  it('returns the rows when Ivanti sends rows', () => {
    expect(readCollection<{ RecId: string }>({ value: [{ RecId: 'a' }] }, URL)).toEqual([
      { RecId: 'a' },
    ]);
  });

  it('treats an empty body as no rows — how an entity set answers a filter that matches nothing', () => {
    expect(readCollection(undefined, URL)).toEqual([]);
  });

  it('treats "No instances found." as no rows, not as a 19-row collection', () => {
    // The trap: the string answers .length (19) and [0] ("N") without complaining.
    expect(readCollection({ value: 'No instances found.' }, URL)).toEqual([]);
    expect(readCollection({ value: 'no instances found' }, URL)).toEqual([]);
  });

  it('refuses any other message rather than reporting it as an empty result', () => {
    expect(() => readCollection({ value: 'Access denied.' }, URL)).toThrow(IvantiApiError);
    expect(() => readCollection({ value: 'Access denied.' }, URL)).toThrow(/Access denied/);
  });

  it('refuses a 200 whose body has no collection at all', () => {
    expect(() => readCollection({ RecId: 'a' }, URL)).toThrow(/no "value" collection/);
    expect(() => readCollection({ value: 42 }, URL)).toThrow(/no "value" collection/);
  });

  it('refuses a 200 that is not an object', () => {
    expect(() => readCollection('surprise', URL)).toThrow(/string where a collection/);
  });

  it('carries the URL, so the failure says which read it was', () => {
    try {
      readCollection({ value: 'Access denied.' }, URL);
      expect.unreachable();
    } catch (error) {
      expect((error as IvantiApiError).url).toBe(URL);
      expect((error as IvantiApiError).status).toBe(200);
    }
  });
});
