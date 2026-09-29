// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import type { CallContext } from '../tool-definition.js';
import { createListRequestOfferingsTool } from './list-request-offerings.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const body = (result: CallToolResult): Record<string, unknown> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, unknown>;
};

function pinned(): CallContext {
  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
  context.pin?.pin({
    recId: 'E1',
    category: 'employee',
    displayName: 'Paul H Chang',
    matchedOn: 'LoginID',
    provenance: 'asserted',
  });
  return context;
}

/** A catalogue of `count` offerings, named so they sort in the order they are numbered. */
function catalogue(count: number) {
  const offerings = Array.from({ length: count }, (_, i) => ({
    strSubscriptionId: `sub-${String(i)}`,
    strRecId: `tpl-${String(i)}`,
    strName: `Offering ${String(i).padStart(3, '0')}`,
    strDescription: i === 7 ? 'A replacement laptop' : 'Something else',
  }));
  const { connection } = connectionFixture({ responses: { 'Template/': offerings } });
  return createListRequestOfferingsTool({
    connection,
    gate: OPEN_GATE,
    logger: logger(),
    ownRecordsOnly: false,
    actions: OPEN_ACTIONS,
  });
}

describe('list_request_offerings', () => {
  it('lists a catalogue that fits whole, and says there is nothing more', async () => {
    const result = body(await catalogue(3).handler({}, pinned()));

    expect(result).toMatchObject({ returned: 3, total: 3, hasMore: false });
    expect(result).not.toHaveProperty('hasMoreNote');
  });

  it('cuts a long catalogue, and says how many there are and how to narrow it', async () => {
    // The whole catalogue — 132 offerings on a stock tenant — came back on every call.
    const result = body(await catalogue(132).handler({}, pinned()));

    expect(result).toMatchObject({ returned: 50, total: 132, hasMore: true });
    expect((result['offerings'] as unknown[]).length).toBe(50);
    expect(String(result['hasMoreNote'])).toContain('`search`');
  });

  it('counts what the search matched, not the whole catalogue', async () => {
    const result = body(await catalogue(132).handler({ search: 'laptop' }, pinned()));

    expect(result).toMatchObject({ returned: 1, total: 1, hasMore: false });
  });
});
