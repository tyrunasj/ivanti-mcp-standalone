// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import {
  servesEntity,
  toCsdlEntity,
  toEnglishSingular,
  toEntitySet,
  toGuessedEntitySet,
} from './entity-names.js';

describe('toEntitySet', () => {
  it('converts the AdminUI id to the CRUD entity set', () => {
    expect(toEntitySet('Incident#')).toBe('Incidents');
    expect(toEntitySet('CI#Computer')).toBe('CI__Computers');
    expect(toEntitySet('CI.Server')).toBe('CI__Servers');
  });

  it('appends a literal s — this is not English pluralisation', () => {
    expect(toEntitySet('IncidentStatus#')).toBe('IncidentStatuss');
    expect(toEntitySet('Category#')).toBe('Categorys');
  });

  it('passes a bare name through rather than guessing', () => {
    // 'IncidentStatus' could be the set or the singular, and a wrong guess returns an empty
    // result instead of an error — so the guess is refused here and made explicit elsewhere.
    expect(toEntitySet('Incidents')).toBe('Incidents');
    expect(toEntitySet('IncidentStatus')).toBe('IncidentStatus');
  });
});

describe('toCsdlEntity', () => {
  it('reduces every dialect to the name $metadata is keyed by', () => {
    expect(toCsdlEntity('Incidents')).toBe('Incident');
    expect(toCsdlEntity('Incident#')).toBe('Incident');
    expect(toCsdlEntity('CI#Computer')).toBe('CI__Computer');
    expect(toCsdlEntity('CI__Computers')).toBe('CI__Computer');
  });

  it('leaves a singular that does not end in s alone', () => {
    expect(toCsdlEntity('Incident')).toBe('Incident');
  });
});

describe('toGuessedEntitySet', () => {
  it('guesses the plural, lowercased, where an empty result is an acceptable failure', () => {
    expect(toGuessedEntitySet('Incident#')).toBe('incidents');
    expect(toGuessedEntitySet('Incident')).toBe('incidents');
    expect(toGuessedEntitySet('Incidents')).toBe('incidents');
    expect(toGuessedEntitySet('CI#Computer')).toBe('ci__computers');
  });
});

describe('servesEntity', () => {
  it('accepts a subtype for a base type', () => {
    expect(servesEntity('Task#', 'Task#Assignment')).toBe(true);
    expect(servesEntity('CI#', 'CI#Computer')).toBe(true);
  });

  it('requires a named subtype to be served exactly', () => {
    expect(servesEntity('CI#Computer', 'CI#MobileDevice')).toBe(false);
  });

  it('rejects a different object, and an absent one', () => {
    expect(servesEntity('Task#', 'Incident#')).toBe(false);
    expect(servesEntity('Task#', undefined)).toBe(false);
    expect(servesEntity('Task#', '')).toBe(false);
  });

  it('is case-insensitive, because Ivanti is inconsistent about casing', () => {
    expect(servesEntity('task#', 'Task#Assignment')).toBe(true);
  });
});

describe('toEnglishSingular', () => {
  it('undoes the English plural a caller applied, for the recovery path only', () => {
    expect(toEnglishSingular('Categories')).toBe('Category');
    expect(toEnglishSingular('Statuses')).toBe('Status');
    expect(toEnglishSingular('Incidents')).toBe('Incident');
    expect(toEnglishSingular('Boxes')).toBe('Box');
  });

  it('ignores a name that is not pluralised the English way', () => {
    expect(toEnglishSingular('Incident')).toBeUndefined();
    expect(toEnglishSingular('Incident#')).toBeUndefined();
    // Ivanti's own literal-s form must not be "corrected" into something else here.
    expect(toEnglishSingular('IncidentStatuss')).toBeUndefined();
  });
});
