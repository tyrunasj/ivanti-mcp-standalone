import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { createListAssignedWorkTool } from './list-assigned-work.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const EMPLOYEE = {
  value: [{ LoginID: 'JSmith', DisplayName: 'Jon Smith', PrimaryEmail: 'jon@example.com' }],
};

const body = (result: CallToolResult): Record<string, never> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, never>;
};

const tool = (responses: Record<string, unknown>) => {
  const { connection, urls } = connectionFixture({ responses });
  return { urls, tool: createListAssignedWorkTool({ connection, logger: logger() }) };
};

describe('list_assigned_work', () => {
  it('resolves the person, then asks each work object about them', async () => {
    const { tool: work, urls } = tool({
      employees: EMPLOYEE,
      incidents: { value: [{ RecId: 'i1', IncidentNumber: 1, Subject: 'a' }], '@odata.count': 8 },
    });

    const result = body(await work.handler({ person: 'jon@example.com' }));

    expect(result.person).toMatchObject({ loginId: 'JSmith', matchedOn: 'loginId' });
    expect(result.groups).toHaveLength(5);
    expect(urls.filter((url) => url.includes('incidents'))).toHaveLength(1);
  });

  it('escapes the login so an apostrophe cannot break the filter', async () => {
    const { tool: work, urls } = tool({
      employees: { value: [{ LoginID: "O'Brien" }] },
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
    expect(String(result.message)).toContain('No employee matches');
  });
});
