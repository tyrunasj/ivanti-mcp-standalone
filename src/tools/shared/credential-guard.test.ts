// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every record operation must run on the caller's credential, and a new one must not quietly
 * skip it.
 *
 * A forgotten `transportFor` does not fail: it answers as the service account, returning rows the
 * caller may not be entitled to and stamping their writes with the wrong name. Nothing about that
 * looks wrong in a test or a log, which is exactly why it is worth a guard rather than a
 * convention — the same argument `own-records-guard.test.ts` makes about the ownership check.
 *
 * So a file under `tools/` that reaches for `deps.connection.transport` must appear below with a
 * reason. Adding a tool that talks to Ivanti and forgetting this fails the build.
 */

/**
 * Files that deliberately keep the service account, and why.
 *
 * Every entry answers the same question: is this call about **what one person may see**, or about
 * **what the tenant is**? Only the first belongs on the caller's credential.
 */
const SERVICE_ACCOUNT_BY_DESIGN: Record<string, string> = {
  'schema/get-link-fields.ts':
    'Samples rows to learn a link field\'s `_Category` spelling. That is a fact about the tenant, ' +
    'not about the caller, and reading it per person would make a process-wide answer vary by ' +
    'conversation.',
};

const TOOLS_DIR = new URL('..', import.meta.url).pathname;

function sourceFiles(dir: string, prefix = ''): { name: string; body: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, `${prefix}${entry.name}/`);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    if (entry.name.endsWith('.fixture.ts')) return [];
    return [{ name: `${prefix}${entry.name}`, body: readFileSync(path, 'utf8') }];
  });
}

describe('which credential a tool talks to Ivanti on', () => {
  it('has every record operation going through transportFor, or declared with a reason', () => {
    const offenders = sourceFiles(TOOLS_DIR)
      .filter(({ name }) => name !== 'shared/transport-for.ts' && name !== 'shared/connection-for.ts')
      .filter(({ body }) => /deps\.connection\.(transport|session|forms|workspaces)\b(?!\s*,)/.test(stripResolved(body)))
      .map(({ name }) => name)
      .filter((name) => !(name in SERVICE_ACCOUNT_BY_DESIGN));

    expect(
      offenders,
      'These reach for a service-account surface without resolving the caller\'s first. ' +
        'Use `connectionFor(deps, context)`, or add the file to ' +
        'SERVICE_ACCOUNT_BY_DESIGN with the reason it is a tenant fact rather than a person\'s ' +
        `data:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps the declared exceptions honest by requiring them to still exist', () => {
    const names = new Set(sourceFiles(TOOLS_DIR).map(({ name }) => name));
    const stale = Object.keys(SERVICE_ACCOUNT_BY_DESIGN).filter((name) => !names.has(name));

    // A stale exemption is worse than none: it reads as a considered decision about a file that
    // has since moved or been deleted.
    expect(stale, `declared but no longer present:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});

/** The resolution itself names the base transport; that occurrence is the point, not a miss. */
function stripResolved(body: string): string {
  return body.replaceAll('transportFor(deps.connection.transport, context)', '');
}
