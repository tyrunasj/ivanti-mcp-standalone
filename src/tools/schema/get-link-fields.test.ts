// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import { IvantiApiError } from '../../ivanti/http/errors.js';
import { formFixture } from '../../ivanti/session/form.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { createGetLinkFieldsTool } from './get-link-fields.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const tool = (responses: Record<string, unknown>) => {
  const { connection } = connectionFixture({
    entities: { incident: { fields: [field('RecId'), field('ProfileLink_Category')] } },
    capability: { tier: 'session' },
    responses,
  });
  const forms = {
    get: () => Promise.resolve(formFixture({ linkFields: { ProfileLink: 'ProfileLink_RecID' } })),
  };
  return createGetLinkFieldsTool({
    connection: { ...connection, forms },
    gate: OPEN_GATE,
    logger: logger(),
    ownRecordsOnly: false,
    actions: OPEN_ACTIONS,
  });
};

const body = (result: CallToolResult): Record<string, unknown> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, unknown>;
};

describe('get_link_fields', () => {
  it('lists the categories the sample held', async () => {
    const result = body(
      await tool({
        incidents: { value: [{ RecId: 'a', ProfileLink_Category: 'Employee' }] },
      }).handler({ object: 'Incidents' }),
    );

    expect(result).not.toHaveProperty('sampleFailed');
    expect(JSON.stringify(result['links'])).toContain('Employee');
    expect(String(result['note'])).toContain('simply unset on all');
  });

  it('does not call a link "unset on all rows sampled" when the sample was never read', async () => {
    const result = body(
      await tool({
        incidents: new IvantiApiError({ status: 503, method: 'GET', url: 'u', body: '' }),
      }).handler({ object: 'Incidents' }),
    );

    expect(result['sampleFailed']).toBe(true);
    expect(String(result['note'])).not.toContain('simply unset');
    expect(String(result['note'])).toContain('COULD NOT BE READ');
  });
});
