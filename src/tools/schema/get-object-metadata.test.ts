import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import type { Logger } from '../../logger.js';
import { createGetObjectMetadataTool } from './get-object-metadata.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const INCIDENT = {
  fields: [
    field('RecId', { nullable: false }),
    field('Subject'),
    field('Status', { validated: true }),
    field('Status_Valid', { internalTwin: true }),
    field('Priority', { type: 'Edm.Int32' }),
  ],
  relationships: [{ name: 'IncidentContainsTask', target: 'task' }],
};

const tool = () => {
  const { connection } = connectionFixture({ entities: { incident: INCIDENT } });
  return createGetObjectMetadataTool({ connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS });
};

type Payload = Record<string, unknown>;

const payload = (result: { content: { type: string; text?: string }[] }): Payload =>
  JSON.parse(result.content[0]?.text ?? '{}') as Payload;

describe('get_object_metadata', () => {
  it('reports fields with short types, and marks required and validated ones', async () => {
    const body = payload(await tool().handler({ object: 'Incident#' }));

    expect(body).toMatchObject({
      object: 'incident',
      entitySet: 'incidents',
      fields: [
        { name: 'RecId', type: 'String', required: true },
        { name: 'Subject', type: 'String' },
        { name: 'Status', type: 'String', validated: true },
        { name: 'Priority', type: 'Int32' },
      ],
      relationships: [{ name: 'IncidentContainsTask', target: 'task' }],
    });
  });

  it("hides Ivanti's internal _Valid pointer fields", async () => {
    const body = payload(await tool().handler({ object: 'Incidents' }));

    expect(JSON.stringify(body)).not.toContain('Status_Valid');
  });

  it('filters fields by substring, because an object can carry 250 of them', async () => {
    const body = payload(await tool().handler({ object: 'incident', search: 'stat' }));

    expect(body).toMatchObject({ fieldCount: 1, searchedFor: 'stat' });
  });

  it('omits relationships on request', async () => {
    const body = payload(await tool().handler({ object: 'incident', includeRelationships: false }));

    expect(body.relationships).toBeUndefined();
  });

  it('answers a wrong name with suggestions rather than a protocol error', async () => {
    const result = (await tool().handler({ object: 'Categories' })) as {
      isError?: boolean;
      content: { text?: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Did you mean');
  });
});
