// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { readSecret } from './read-secret-file.js';

describe('readSecret', () => {
  it('returns the inline value when no file is configured', () => {
    expect(readSecret({ TOKEN: 'abc' }, 'TOKEN')).toBe('abc');
  });

  it('returns undefined when neither form is set', () => {
    expect(readSecret({}, 'TOKEN')).toBeUndefined();
  });

  it('reads and trims the file when the *_FILE form is used', () => {
    const readFile = vi.fn().mockReturnValue('  secret\n');

    expect(readSecret({ TOKEN_FILE: '/run/secrets/t' }, 'TOKEN', readFile)).toBe('secret');
    expect(readFile).toHaveBeenCalledWith('/run/secrets/t');
  });

  it('rejects supplying both forms rather than picking one', () => {
    expect(() => readSecret({ TOKEN: 'a', TOKEN_FILE: '/x' }, 'TOKEN', () => 'b')).toThrow(
      /provide exactly one/,
    );
  });

  it('rejects an empty secret file', () => {
    expect(() => readSecret({ TOKEN_FILE: '/x' }, 'TOKEN', () => '   \n')).toThrow(/is empty/);
  });
});
