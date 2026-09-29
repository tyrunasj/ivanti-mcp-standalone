// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import type { Logger } from '../../logger.js';
import { createListAssignedWorkTool } from './list-assigned-work.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { ANONYMOUS } from '../../auth/identity.js';
import type { CallContext } from '../tool-definition.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const EMPLOYEE = {
  value: [
    {
      RecId: 'e1',
      LoginID: 'JSmith',
      FirstName: 'Jon',
      LastName: 'Smith',
      DisplayName: 'Jon Smith',
      PrimaryEmail: 'jon@example.com',
    },
  ],
};

const body = (result: CallToolResult): Record<string, never> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, never>;
};

const tool = (responses: Record<string, unknown>) => {
  // `employee` registered, so the shared person directory has an object to look people up in.
  const { connection, urls } = connectionFixture({ entities: { employee: {} }, responses });
  return { urls, tool: createListAssignedWorkTool({ connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS }) };
};

describe('list_assigned_work', () => {
  it('resolves the person, then asks each work object about them', async () => {
    const { tool: work, urls } = tool({
      employees: EMPLOYEE,
      incidents: { value: [{ RecId: 'i1', IncidentNumber: 1, Subject: 'a' }], '@odata.count': 8 },
    });

    const result = body(await work.handler({ person: 'jon@example.com' }));

    expect(result.person).toMatchObject({ loginId: 'JSmith', matchedOn: 'PrimaryEmail' });
    expect(result.groups).toHaveLength(5);
    expect(urls.filter((url) => url.includes('incidents'))).toHaveLength(1);
  });

  it('escapes the login so an apostrophe cannot break the filter', async () => {
    const { tool: work, urls } = tool({
      employees: { value: [{ RecId: 'e2', LoginID: "O'Brien" }] },
    });

    await work.handler({ person: "O'Brien" });

    expect(urls.some((url) => url.includes("O''Brien"))).toBe(true);
  });

  it('excludes terminal statuses by default and says which filter it used', async () => {
    const { tool: work } = tool({ employees: EMPLOYEE });

    const result = body(await work.handler({ person: 'JSmith' }));
    const incidents = (result.groups as unknown as { object: string; filter: string }[])[0];

    expect(result.closedExcluded).toBe(true);
    expect(incidents?.filter).toContain("Status ne 'Closed'");
    expect(incidents?.filter).toContain("Status ne 'Resolved'");
  });

  it('includes everything when asked', async () => {
    const { tool: work } = tool({ employees: EMPLOYEE });

    const result = body(await work.handler({ person: 'JSmith', includeClosed: true }));
    const incidents = (result.groups as unknown as { filter: string }[])[0];

    expect(incidents?.filter).toBe("Owner eq 'JSmith'");
  });

  it('reports a refused object on its own group rather than failing the answer', async () => {
    const { tool: work } = tool({
      employees: EMPLOYEE,
      changes: new Error('403 forbidden'),
    });

    const groups = body(await work.handler({ person: 'JSmith' })).groups as unknown as {
      object: string;
      error?: string;
    }[];

    expect(groups.find((group) => group.object === 'changes')?.error).toContain('403');
    expect(groups.filter((group) => group.error === undefined)).toHaveLength(4);
  });

  it('says plainly when nobody matches, rather than reporting an empty plate', async () => {
    const { tool: work } = tool({});

    const result = body(await work.handler({ person: 'ghost' }));

    expect(result.person).toBeNull();
    expect(String(result.message)).toContain('No single employee matches');
  });

  /**
   * Two people answer to the name, and the old ladder asked for two rows and took the first —
   * so the answer was one of their queues, presented as the one asked about.
   */
  it('refuses a name two people share rather than picking one of them', async () => {
    const { tool: work, urls } = tool({
      employees: {
        value: [
          { RecId: 'e1', LoginID: 'JSmith', FirstName: 'Jane', LastName: 'Smith', DisplayName: 'Jane Smith' },
          { RecId: 'e2', LoginID: 'JSmith2', FirstName: 'Jane', LastName: 'Smith', DisplayName: 'Jane A Smith' },
        ],
      },
    });

    const result = body(await work.handler({ person: 'Jane Smith' }));

    expect(result.person).toBeNull();
    expect(String(result.message)).toContain('more than one person');
    // And no queue was read for either of them.
    expect(urls.some((url) => url.includes('Owner%20eq'))).toBe(false);
  });

  it('uses the pinned person without looking them up again', async () => {
    const { tool: work, urls } = tool({});
    const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
    context.pin?.pin({
      recId: 'e1',
      category: 'employee',
      displayName: 'Jon Smith',
      loginId: 'JSmith',
      matchedOn: 'LoginID',
      provenance: 'asserted',
    });

    const result = body(await work.handler({}, context));

    expect(result.person).toMatchObject({ loginId: 'JSmith', matchedOn: 'the pinned identity' });
    expect(urls.some((url) => url.includes('employees'))).toBe(false);
  });
});
