// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import type { CallContext } from '../tool-definition.js';
import { zeroNote as note2, type ZeroContext } from './zero-note.js';

const plain: CallContext = { identity: ANONYMOUS };
const zeroNote = (context: ZeroContext, call: CallContext = plain): string => note2(context, call);

describe('zeroNote branches', () => {
  it('calls a filter zero a real one', () => {
    const note = zeroNote({ looked: 'incidents' });

    expect(note).toContain('No incidents.');
    expect(note).toContain('REAL ZERO');
  });

  it('calls a keyword zero the weak kind and names the keyword', () => {
    const note = zeroNote({ looked: 'incidents', keyword: 'png' });

    expect(note).toContain("matched the keyword 'png'");
    expect(note).toContain('WEAK KIND');
    expect(note).not.toContain('REAL ZERO');
  });

  it('treats an empty keyword as no keyword', () => {
    expect(zeroNote({ looked: 'incidents', keyword: '' })).toContain('REAL ZERO');
  });

  it('says a scoped zero is about one person', () => {
    expect(zeroNote({ looked: 'incidents', scopedTo: 'Ann' })).toContain('narrowed to Ann');
  });

  it('takes the strength back for an impersonated zero', () => {
    const impersonated = {
      identity: ANONYMOUS,
      impersonation: { session: () => ({ loginId: 'Ann' }) },
    } as unknown as CallContext;
    const note = zeroNote({ looked: 'incidents' }, impersonated);

    expect(note).toContain('NOT THE STRONG KIND');
    expect(note).toContain('Ann');
  });

  it('names the objects a gate allows, and only when there are some', () => {
    expect(zeroNote({ looked: 'x', gated: ['Incident', 'Task'] })).toContain('only Incident, Task');
    expect(zeroNote({ looked: 'x', gated: [] })).not.toContain('exposes only');
  });

  it('appends the tool’s own sentence last', () => {
    expect(zeroNote({ looked: 'x', because: 'Specific.' }).endsWith('Specific.')).toBe(true);
  });
});
