// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { configFixture } from '../../config/config.fixture.js';
import { createObjectGate, ObjectNotAllowedError, OPEN_GATE } from './object-gate.js';

const enduser = (objects: string[]) =>
  createObjectGate(configFixture({ MCP_MODE: 'enduser', ENDUSER_BUSINESS_OBJECTS: objects }));

describe('createObjectGate', () => {
  it('lets full mode reach anything — the audience is IT staff', () => {
    const gate = createObjectGate(configFixture({ MCP_MODE: 'full' }));

    expect(gate.allows('anything_at_all')).toBe(true);
    expect(gate.allowed).toEqual([]);
  });

  it('admits only the allowlist in enduser mode, in any dialect', () => {
    const gate = enduser(['incident', 'change', 'servicereq']);

    expect(gate.allows('Incident#')).toBe(true);
    expect(gate.allows('Incidents')).toBe(true);
    expect(gate.allows('incident')).toBe(true);
    expect(gate.allows('ServiceReqs')).toBe(true);
    expect(gate.allows('Employees')).toBe(false);
    expect(gate.allows('frs_hc_calllog')).toBe(false);
  });

  it('refuses everything when the allowlist is empty rather than opening up', () => {
    // validateConfig already refuses to start in this state; the gate must not fail open anyway.
    expect(enduser([]).allows('Incidents')).toBe(false);
  });

  it('names what is allowed when it refuses', () => {
    const error = new ObjectNotAllowedError('Employees', ['incident', 'change']);

    expect(error.message).toContain('incident, change');
    expect(error.message).toContain("'Employees' is not one of them");
  });

  it('OPEN_GATE is what full mode gets', () => {
    expect(OPEN_GATE.allows('anything')).toBe(true);
  });
});

/**
 * An object whose own CSDL name ends in `s`.
 *
 * The gate resolved a reference through `toCsdlEntity`, which strips a trailing `s` — right for
 * `Incidents`, wrong for `journal__notes`. With the allowlist collapsed the same way, the two
 * agreed on a name the tenant does not have, so the object was unreachable while every refusal
 * listed it as allowed. Both sides now keep the name as given as well as the guess.
 */
describe('an allowlisted object whose name really ends in s', () => {
  const gate = createObjectGate(
    configFixture({ MCP_MODE: 'enduser', ENDUSER_BUSINESS_OBJECTS: ['journal__notes', 'incident'] }),
  );

  it.each([
    ['as given', 'journal__notes'],
    ['in another casing', 'Journal__Notes'],
  ])('allows it %s', (_label, ref) => {
    expect(gate.allows(ref)).toBe(true);
  });

  // Still a gate: nothing outside the list gets through, and the singular is not the same object.
  it.each(['journal__note', 'employee', 'change'])('still refuses %s', (ref) => {
    expect(gate.allows(ref)).toBe(false);
  });

  it('still resolves the ordinary plural dialect', () => {
    expect(gate.allows('Incidents')).toBe(true);
    expect(gate.allows('Incident#')).toBe(true);
  });
});
