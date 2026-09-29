// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { field } from '../../ivanti/connection.fixture.js';
import { formFixture } from '../../ivanti/session/form.fixture.js';
import type { EntityMetadata } from '../../ivanti/metadata/csdl.js';
import { FieldNameError } from './explain-field-error.js';
import { assertKnownFields, FieldNotOnObjectError, knownFields } from './known-fields.js';

const incident = (names: string[] = ['Subject', 'Symptom', 'Status', 'Category', 'ProfileLink_RecID', 'ProfileLink_Category']): EntityMetadata =>
  ({ name: 'incident', fields: names.map((n) => field(n)), relationships: [] });

const message = (fn: () => void): string => {
  try { fn(); return ''; } catch (error) { return (error as Error).message; }
};

describe('assertKnownFields', () => {
  it('passes a write whose names are all real, link pair included', () => {
    expect(() => {
      assertKnownFields(['Subject', 'Symptom', 'ProfileLink_RecID', 'ProfileLink_Category'], incident());
    }).not.toThrow();
  });

  it('matches the tenant spelling case-insensitively', () => {
    expect(() => { assertKnownFields(['subject'], incident()); }).not.toThrow();
  });

  /** The write that started this: `Status` guessed onto an object that has no such field. */
  it('refuses a field the object does not have', () => {
    const thrown = message(() => { assertKnownFields(['FirstName', 'Status'], incident(['FirstName'])); });

    expect(thrown).toContain('`Status` is not a field on this object');
    expect(thrown).toContain('Nothing was written');
    expect(thrown).toContain('get_object_metadata for incident');
  });

  it('is typed as the caller\'s mistake, and names the fields', () => {
    try {
      assertKnownFields(['Nope'], incident());
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(FieldNotOnObjectError);
      expect((error as FieldNotOnObjectError).fields).toEqual(['Nope']);
    }
  });

  /**
   * A label is not a field, and "no such field" would read as "this object cannot hold one" —
   * which is exactly wrong when the tenant simply calls `Symptom` something else.
   */
  it('translates a display name into the field it labels', () => {
    const thrown = message(() => {
      assertKnownFields(['Description'], incident(), formFixture({ displayNames: { description: 'Symptom' } }));
    });

    expect(thrown).toContain('`Description` is what this tenant CALLS a field');
    expect(thrown).toContain('write `Symptom`');
  });

  /** `suggestNames` ranks by containment, and a transposition contains nothing. */
  it('suggests a field a single slip away, which containment cannot see', () => {
    expect(message(() => { assertKnownFields(['Sympton'], incident()); })).toContain('did you mean `Symptom`?');
    expect(message(() => { assertKnownFields(['Subjekt'], incident()); })).toContain('did you mean `Subject`?');
  });

  it('offers nothing for a name that is simply not this object\'s', () => {
    const thrown = message(() => { assertKnownFields(['Wibble'], incident()); });

    expect(thrown).toContain('`Wibble` is not a field on this object');
    expect(thrown).not.toContain('did you mean');
  });

  /**
   * An unknown entity set makes Ivanti fabricate a field-less type and return it as valid CSDL.
   * Refusing every field of it would bury the real error, which is the object name.
   */
  it('never refuses when the schema carries no fields at all', () => {
    expect(() => { assertKnownFields(['Anything'], incident([])); }).not.toThrow();
  });

  it('names every unknown field at once, rather than one per round trip', () => {
    const thrown = message(() => { assertKnownFields(['Nope', 'Wibble'], incident()); });

    expect(thrown).toContain('`Nope`');
    expect(thrown).toContain('`Wibble`');
  });

  // Typed as a refusal, so `runTool` answers it as one rather than logging a fault.
  it('is a FieldNameError, which is what the tool runner treats as a caller\'s mistake', () => {
    expect(() => { assertKnownFields(['Nope'], incident()); }).toThrow(FieldNameError);
  });
});

/**
 * The name check matched case-insensitively and handed the caller's spelling on — to lookups that
 * were exact. `status` passed the check and then missed the picklist, its identifier and the
 * read-back, so a bogus value went out unresolved and came back reported as written.
 */
describe('knownFields', () => {
  it('returns the write keyed by the schema spelling', () => {
    expect(knownFields({ status: 'Active', SUBJECT: 'x', Symptom: 'y' }, incident())).toEqual({
      Status: 'Active',
      Subject: 'x',
      Symptom: 'y',
    });
  });

  it('refuses the same field twice in two spellings, and names both', () => {
    const thrown = message(() => { knownFields({ Status: 'Active', status: 'Logged' }, incident()); });

    expect(thrown).toContain('`Status` and `status` name ONE field');
    expect(thrown).toContain('Nothing was written');
  });

  it('still refuses a field the object does not have', () => {
    expect(() => knownFields({ Nope: 1 }, incident())).toThrow(FieldNotOnObjectError);
  });

  it('keeps the caller spelling when there is no schema to take one from', () => {
    expect(knownFields({ anything: 1 }, incident([]))).toEqual({ anything: 1 });
  });
});
