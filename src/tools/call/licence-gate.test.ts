// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import type { ToolDefinition } from '../tool-definition.js';
import { createLicenceGate, type LicenceCheck } from './licence-gate.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const tool = (name: string): ToolDefinition => ({ name }) as ToolDefinition;

const closed: LicenceCheck = { view: () => ({ status: 'closed', reason: 'the licence ended on 2026-01-31' }) };

describe('createLicenceGate', () => {
  it('admits everything when no licence check is given', () => {
    expect(createLicenceGate(undefined, logger()).admit(tool('get_record'))).toBeUndefined();
  });

  it.each(['open', 'grace'] as const)('admits a call while the licence is %s', (status) => {
    const gate = createLicenceGate({ view: () => ({ status }) }, logger());

    expect(gate.admit(tool('get_record'))).toBeUndefined();
  });

  it('refuses a tool while closed, naming the tool and the reason, and logs the refusal', () => {
    const warn = vi.fn();

    const refusal = createLicenceGate(closed, { ...logger(), warn }).admit(tool('get_record'));

    expect(refusal?.isError).toBe(true);
    const text = refusal?.content[0]?.type === 'text' ? refusal.content[0].text : '';
    expect(text).toContain('`get_record`');
    expect(text).toContain('the licence ended on 2026-01-31');
    expect(warn).toHaveBeenCalledWith('tool refused: not licensed', expect.objectContaining({ tool: 'get_record' }));
  });

  it('lets get_version through while closed', () => {
    expect(createLicenceGate(closed, logger()).admit(tool('get_version'))).toBeUndefined();
  });

  it('says so when a closed licence gives no reason', () => {
    const refusal = createLicenceGate({ view: () => ({ status: 'closed' }) }, logger()).admit(tool('act_as'));

    expect(JSON.stringify(refusal?.content)).toContain('the licence is not valid');
  });
});
