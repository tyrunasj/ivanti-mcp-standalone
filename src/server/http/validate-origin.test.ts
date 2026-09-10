import { describe, expect, it } from 'vitest';
import { isOriginAllowed } from './validate-origin.js';

const allowed = ['https://claude.ai'];

describe('isOriginAllowed', () => {
  it('allows a request with no Origin, as non-browser clients send none', () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
  });

  it('allows a listed origin', () => {
    expect(isOriginAllowed('https://claude.ai', allowed)).toBe(true);
  });

  it('rejects an unlisted origin', () => {
    expect(isOriginAllowed('https://evil.example', allowed)).toBe(false);
  });

  it('rejects everything with an Origin when the allowlist is empty', () => {
    expect(isOriginAllowed('https://claude.ai', [])).toBe(false);
  });

  it('does not treat a prefix match as a match', () => {
    expect(isOriginAllowed('https://claude.ai.evil.example', allowed)).toBe(false);
  });
});
