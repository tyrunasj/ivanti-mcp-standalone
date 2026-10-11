// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import { createImpersonationSlot } from '../../auth/impersonation.js';
import { impersonatedSessionFixture } from '../../ivanti/session/impersonated-session.fixture.js';
import type { CallContext } from '../tool-definition.js';
import { QUERY_WORDS, noHitsNote } from './query-words.js';

const CALL: CallContext = { identity: ANONYMOUS };

describe('search query semantics', () => {
  it('states the four traps a bare "words to look for" hid', () => {
    // All measured live: a space ANDs, `or` widens, `AND` is searched for literally, and a
    // quoted phrase matches nothing.
    expect(QUERY_WORDS).toContain('SPACE MEANS AND');
    expect(QUERY_WORDS).toContain('`or`');
    expect(QUERY_WORDS).toContain('do NOT write `AND`');
    expect(QUERY_WORDS).toContain('do NOT quote a phrase');
  });

  it('tells a multi-word query to narrow before it gives up', () => {
    const note = noHitsNote('projector printer', CALL);
    expect(note).toContain('more than one word');
    expect(note).toContain('BEFORE concluding nothing matches');
  });

  it('does not blame the word count when there is only one word', () => {
    const note = noHitsNote('projector', CALL);
    expect(note).not.toContain('more than one word');
    // The structured-field caveat still applies: that one is about where the index looks.
    expect(note).toContain('INDEXED TEXT');
  });

  it('does not tell an `or` query to widen — it is already as wide as this surface goes', () => {
    expect(noHitsNote('projector or clicker', CALL)).not.toContain('more than one word');
    expect(noHitsNote('projector or clicker', CALL)).toContain('INDEXED TEXT');
  });

  it('says an impersonated zero is that person’s view, not a fact about the tenant', async () => {
    const slot = createImpersonationSlot(() => Promise.resolve(impersonatedSessionFixture()));
    await slot.open('HSanders');

    const note = noHitsNote('projector', { identity: ANONYMOUS, impersonation: slot });

    expect(note).toContain('NOT THE STRONG KIND OF ZERO');
    expect(note).toContain('HSanders');
    expect(noHitsNote('projector', CALL)).not.toContain('NOT THE STRONG KIND OF ZERO');
  });
});
