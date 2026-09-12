import { describe, expect, it } from 'vitest';
import { QUERY_WORDS, noHitsNote } from './query-words.js';

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
    const note = noHitsNote('projector printer');
    expect(note).toContain('more than one word');
    expect(note).toContain('BEFORE concluding nothing matches');
  });

  it('does not blame the word count when there is only one word', () => {
    const note = noHitsNote('projector');
    expect(note).not.toContain('more than one word');
    // The structured-field caveat still applies: that one is about where the index looks.
    expect(note).toContain('INDEXED TEXT');
  });

  it('does not tell an `or` query to widen — it is already as wide as this surface goes', () => {
    expect(noHitsNote('projector or clicker')).not.toContain('more than one word');
    expect(noHitsNote('projector or clicker')).toContain('INDEXED TEXT');
  });
});
