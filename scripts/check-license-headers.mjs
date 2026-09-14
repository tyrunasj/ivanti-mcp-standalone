/**
 * Every TypeScript source file carries the licence header.
 *
 * The software is proprietary and is distributed as an image, a chart and a
 * tarball; a file that escapes one of those without a notice is a file with no
 * stated terms. A lint rule would need a plugin, and this repository already
 * prefers a small script that CI runs — see check-version.mjs.
 *
 *   node scripts/check-license-headers.mjs           # fail on any file missing it
 *   node scripts/check-license-headers.mjs --write   # add it where absent
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;
export const HEADER = [
  '// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial',
  '// Copyright (c) 2026 SYNERGY. All rights reserved.',
].join('\n');
const MARKER = 'SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const write = process.argv[2] === '--write';
const files = walk(SRC).sort();
const missing = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  // Only the first few lines count: a marker buried in the body is a mention,
  // not a notice.
  if (text.split('\n', 3).join('\n').includes(MARKER)) continue;
  if (!write) { missing.push(file); continue; }
  writeFileSync(file, `${HEADER}\n${text.startsWith('\n') ? '' : '\n'}${text}`);
}

if (write) {
  console.log(`licence header present on all ${String(files.length)} source files`);
} else if (missing.length > 0) {
  console.error(`Missing the licence header on ${String(missing.length)} file(s):`);
  for (const f of missing.slice(0, 10)) console.error(`  ${f.replace(SRC, 'src')}`);
  if (missing.length > 10) console.error(`  … and ${String(missing.length - 10)} more`);
  console.error('\nRun: node scripts/check-license-headers.mjs --write');
  process.exit(1);
} else {
  console.log(`licence header present on all ${String(files.length)} source files`);
}
