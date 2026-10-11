// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import { createImpersonationSlot } from '../../auth/impersonation.js';
import { impersonatedSessionFixture } from '../../ivanti/session/impersonated-session.fixture.js';
import type { CallContext } from '../tool-definition.js';
import { impersonatedAs, withImpersonation, zeroNote } from './zero-note.js';

const PLAIN: CallContext = { identity: ANONYMOUS };

const impersonating = async (loginId: string): Promise<CallContext> => {
  const slot = createImpersonationSlot(() => Promise.resolve(impersonatedSessionFixture({ loginId })));
  await slot.open(loginId);
  return { identity: ANONYMOUS, impersonation: slot };
};

describe('zeroNote', () => {
  it('reads the impersonation from the call, so a caller cannot forget it', async () => {
    const note = zeroNote({ looked: 'incidents' }, await impersonating('HSanders'));

    expect(note).toContain('NOT THE STRONG KIND OF ZERO');
    expect(note).toContain('HSanders');
  });

  it('carries no such clause when nobody is impersonated', () => {
    const note = zeroNote({ looked: 'incidents' }, PLAIN);

    expect(note).toContain('THIS IS A REAL ZERO');
    expect(note).not.toContain('NOT THE STRONG KIND OF ZERO');
  });

  it('appends the same retraction to an emitter’s own text, and only when impersonating', async () => {
    const own = 'THAT IS A REAL ZERO.';

    expect(withImpersonation(own, PLAIN)).toBe(own);
    expect(withImpersonation(own, await impersonating('HSanders'))).toContain(
      'NOT THE STRONG KIND OF ZERO',
    );
  });
});

describe('impersonatedAs', () => {
  it('is the login Ivanti applies access for, or nothing', async () => {
    expect(impersonatedAs(PLAIN)).toBeUndefined();
    expect(impersonatedAs(await impersonating('HSanders'))).toBe('HSanders');
  });
});

describe('the impersonation login', () => {
  it('is read through impersonatedAs and nowhere else under tools/ (a copy can be forgotten)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.ts$/.test(entry) &&
          !/\.test\.ts$/.test(entry) &&
          !path.endsWith(join('shared', 'zero-note.ts')) &&
          /impersonation\??\.session\(\)\??\.loginId/.test(readFileSync(path, 'utf8'))
        ) {
          offenders.push(path);
        }
      }
    };
    walk(join(import.meta.dirname, '..'));

    expect(offenders).toEqual([]);
  });
});
