// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { configFixture } from '../../config/config.fixture.js';
import { ActionNotAllowedError, OPEN_ACTIONS, createActionGate } from './action-gate.js';

describe('createActionGate', () => {
  it('is open in full mode, whatever the allowlist says', () => {
    const gate = createActionGate(
      configFixture({ MCP_MODE: 'full', ENDUSER_QUICK_ACTIONS: ['Only This'] }),
    );

    expect(gate).toBe(OPEN_ACTIONS);
    expect(gate.allows('Anything')).toBe(true);
  });

  it('allows only the named actions in enduser mode, ignoring case and padding', () => {
    const gate = createActionGate(
      configFixture({ MCP_MODE: 'enduser', ENDUSER_QUICK_ACTIONS: ['Close From Self Service'] }),
    );

    expect(gate.restricted).toBe(true);
    expect(gate.allows('  close from self service ')).toBe(true);
    expect(gate.allows('Escalate')).toBe(false);
  });

  it('allows nothing in enduser mode when none is named', () => {
    const gate = createActionGate(configFixture({ MCP_MODE: 'enduser', ENDUSER_QUICK_ACTIONS: [] }));

    expect(gate.allows('Close')).toBe(false);
  });
});

describe('ActionNotAllowedError', () => {
  it('lists what is allowed', () => {
    expect(new ActionNotAllowedError('Escalate', ['A', 'B']).message).toContain('It allows: A, B.');
  });

  it('says none is allowed when the list is empty', () => {
    expect(new ActionNotAllowedError('Escalate', []).message).toContain('or any other quick action');
  });
});
