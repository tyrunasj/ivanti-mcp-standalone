import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { selectTools } from './register-tools.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const GATED = configFixture({
  MCP_MODE: 'enduser',
  ENDUSER_BUSINESS_OBJECTS: ['incident', 'change', 'servicereq'],
});

const tools = () => {
  const { connection, urls } = connectionFixture({
    entities: { incident: {}, change: {}, servicereq: {}, employee: {}, frs_hc_calllog: {} },
    responses: {
      incidents: { value: [{ RecId: 'i1', Subject: 'Printer' }] },
      employees: { value: [{ LoginID: 'JSmith' }] },
    },
  });
  const selected = selectTools(GATED, {
    serverName: 'ivanti-mcp',
    serverVersion: '0.1.0',
    logger: logger(),
    ivanti: connection,
  });
  const byName = new Map(selected.map((tool) => [tool.name, tool]));
  return { urls, tool: (name: string) => byName.get(name)! };
};

const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content[0]?.text ?? '';

describe('enduser mode gates every object-taking tool', () => {
  it('refuses an object outside the allowlist, and says which are inside', async () => {
    const { tool, urls } = tools();

    for (const [name, args] of [
      ['list_records', { object: 'Employees' }],
      ['get_record', { object: 'Employees', recordId: 'a' }],
      ['count_records', { object: 'Employees' }],
      ['get_object_metadata', { object: 'Employees' }],
      ['fulltext_search_object', { object: 'Employees', query: 'x' }],
      ['get_related_records', { object: 'Employees', recordId: 'a', relationship: 'r' }],
      ['fetch', { id: 'employees:a' }],
    ] as const) {
      const result = await tool(name).handler(args);

      expect(result.isError, `${name} allowed a gated object`).toBe(true);
      expect(text(result)).toContain('incident, change, servicereq');
    }

    // Nothing reached Ivanti: a refused object must not even be confirmed to exist.
    expect(urls).toEqual([]);
  });

  it('still serves the allowed objects', async () => {
    const { tool } = tools();

    const result = await tool('list_records').handler({ object: 'Incidents' });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('"returned": 1');
  });

  it('narrows the catalog to the allowlist', async () => {
    const { tool } = tools();

    const body = JSON.parse(text(await tool('list_business_objects').handler({}))) as {
      objects: { object: string }[];
    };

    expect(body.objects.map((row) => row.object).sort()).toEqual([
      'change',
      'incident',
      'servicereq',
    ]);
  });

  it('narrows the cross-object search rather than refusing it', async () => {
    const { tool } = tools();

    const body = JSON.parse(text(await tool('search').handler({ query: 'printer' }))) as {
      searched: string[];
    };

    expect(body.searched).toEqual(['incidents', 'servicereqs', 'changes']);
  });

  it('refuses a search aimed at a gated object', async () => {
    const { tool } = tools();

    const body = JSON.parse(
      text(await tool('search').handler({ query: 'x', objects: ['Employees'] })),
    ) as { results: unknown[]; note?: string };

    expect(body.results).toEqual([]);
    expect(body.note).toContain('incident, change, servicereq');
  });

  it('leaves the gated objects out of assigned work', async () => {
    const { tool } = tools();

    const body = JSON.parse(text(await tool('list_assigned_work').handler({ person: 'JSmith' }))) as {
      groups: { object: string }[];
    };

    // tasks and problems are not on the allowlist.
    expect(body.groups.map((group) => group.object)).toEqual([
      'incidents',
      'servicereqs',
      'changes',
    ]);
  });

  it('gates an attachment by the record it hangs off, not by the attachment table', async () => {
    const { connection } = connectionFixture({
      entities: { incident: {} },
      responses: {
        attachments: {
          value: [{ RecId: 'a1', ATTACHNAME: 'payroll.xlsx', ParentLink_Category: 'Employee' }],
        },
      },
    });
    const selected = selectTools(GATED, {
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
      logger: logger(),
      ivanti: connection,
    });
    const attachment = selected.find((tool) => tool.name === 'get_attachment_details')!;

    const result = await attachment.handler({ attachmentId: 'a1' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Employee record');
  });

  it('gates the service request parameter tools on the service request object', async () => {
    const { tool } = tools();
    const open = selectTools(configFixture({ MCP_MODE: 'full' }), {
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
      logger: logger(),
      ivanti: connectionFixture({}).connection,
    });

    // ServiceReq is on this allowlist, so the tool works here…
    const allowed = await tool('get_service_request_parameters').handler({ templateId: 't1' });
    expect(allowed.isError).toBeUndefined();

    // …and in full mode nothing is gated at all.
    expect(open.find((entry) => entry.name === 'get_service_request_parameters')).toBeDefined();
  });
});
