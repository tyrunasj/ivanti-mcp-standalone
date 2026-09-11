import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { createListBusinessObjectsTool } from './list-business-objects.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const tool = (entities: string[]) => {
  const { connection } = connectionFixture({
    entities: Object.fromEntries(entities.map((name) => [name, {}])),
  });
  return { connection, tool: createListBusinessObjectsTool({ connection, logger: logger() }) };
};

interface Catalog {
  count: number;
  hiddenAuditTables: number;
  objects: { object: string; entitySet: string }[];
}

const payload = (result: { content: { type: string; text?: string }[] }): Catalog =>
  JSON.parse(result.content[0]?.text ?? '{}') as Catalog;

describe('list_business_objects', () => {
  it('gives each object the entity-set name the record tools take', async () => {
    const { tool: list } = tool(['incident', 'category']);

    const body = payload(await list.handler({}));

    expect(body.objects).toEqual([
      // A literal `s`, not an English plural: `categorys` is the real entity set.
      { object: 'category', entitySet: 'categorys' },
      { object: 'incident', entitySet: 'incidents' },
    ]);
  });

  it('hides audit shadow tables but says how many it hid', async () => {
    const { tool: list } = tool(['incident', 'audit_incident', 'audit_employee']);

    const body = payload(await list.handler({}));

    expect(body.objects.map((o) => o.object)).toEqual(['incident']);
    expect(body.hiddenAuditTables).toBe(2);
  });

  it('includes audit tables when asked', async () => {
    const { tool: list } = tool(['incident', 'audit_incident']);

    const body = payload(await list.handler({ includeAuditTables: true }));

    expect(body.count).toBe(2);
    expect(body.hiddenAuditTables).toBe(0);
  });

  it('filters case-insensitively on a substring', async () => {
    const { tool: list } = tool(['incident', 'incidentdetail', 'change']);

    const body = payload(await list.handler({ search: 'INCIDENT' }));

    expect(body.objects.map((o) => o.object)).toEqual(['incident', 'incidentdetail']);
  });

  it('widens the catalog first — one graph is not the tenant', async () => {
    const { connection, tool: list } = tool(['incident']);

    await list.handler({});

    expect(connection.metadata.widen).toHaveBeenCalledTimes(1);
  });
});
