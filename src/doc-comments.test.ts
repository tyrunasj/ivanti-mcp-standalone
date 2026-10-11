// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );

describe('doc comments', () => {
  it('has no JSDoc block directly above another, which would attach to nothing', () => {
    const orphans = sources('src')
      .filter((file) => /\/\*\*(?:(?!\*\/)[\s\S])*\*\/\n[ \t]*\/\*\*/.test(readFileSync(file, 'utf8')));

    expect(orphans).toEqual([]);
  });
});
