import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { createLinkRecordsTool } from './link-records.js';
import { createUnlinkRecordsTool } from './unlink-records.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const INCIDENT = entityFixture('incident', {
  relationships: [
    { name: 'IncidentContainsTask', target: 'task' },
    { name: 'IncidentAssociatesCI', target: 'ci' },
  ],
});

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};
const body = (result: CallToolResult): Record<string, never> =>
  JSON.parse(text(result) || '{}') as Record<string, never>;

const deps = (responses: Record<string, unknown>) => {
  const { connection, urls } = connectionFixture({ entities: { incident: INCIDENT }, responses });
  return { urls, deps: { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false } };
};

const ARGS = {
  object: 'Incidents',
  recordId: 'abc',
  relationship: 'incidentcontainstask',
  targetId: 't1',
};

describe('link_records', () => {
  it('PATCHes the $Ref route and accepts Ivanti’s success code', async () => {
    const { deps: d, urls } = deps({ IncidentContainsTask: { code: 'ISM_2000' } });

    const result = body(await createLinkRecordsTool(d).handler(ARGS));

    expect(result).toMatchObject({ relationship: 'IncidentContainsTask', linked: 't1' });
    expect(urls[0]).toContain("incidents('abc')/IncidentContainsTask('t1')/$Ref");
    expect(urls[0]?.startsWith('PATCH')).toBe(true);
  });

  it('treats a failure code in a 200 as a failure', async () => {
    // Ivanti answers relationship problems with 200 and a code, so the status says nothing.
    const { deps: d } = deps({ IncidentContainsTask: { code: 'ISM_4000' } });

    const result = await createLinkRecordsTool(d).handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('ISM_4000');
  });

  it('rejects a relationship the object does not have, with the ones it does', async () => {
    const { deps: d, urls } = deps({});

    const result = await createLinkRecordsTool(d).handler({ ...ARGS, relationship: 'Tasks' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('IncidentContainsTask');
    expect(urls).toEqual([]);
  });
});

describe('unlink_records', () => {
  it('refuses when the link is not there — Ivanti would accept it and damage a third record', async () => {
    const { deps: d, urls } = deps({ IncidentContainsTask: { value: [{ RecId: 'someone-else' }] } });

    const result = await createUnlinkRecordsTool(d).handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('severed the target from whichever record IS its parent');
    expect(urls.some((url) => url.startsWith('DELETE'))).toBe(false);
  });

  it('unlinks when the link is there', async () => {
    const { deps: d, urls } = deps({
      IncidentContainsTask: { value: [{ RecId: 't1' }], code: 'ISM_2000' },
    });

    const result = body(await createUnlinkRecordsTool(d).handler(ARGS));

    expect(result).toMatchObject({ relationship: 'IncidentContainsTask', unlinked: 't1' });
    expect(urls.some((url) => url.startsWith('DELETE'))).toBe(true);
  });

  it('matches the target id whatever its case', async () => {
    const { deps: d } = deps({
      IncidentContainsTask: { value: [{ RecId: 'T1' }], code: 'ISM_2000' },
    });

    expect((await createUnlinkRecordsTool(d).handler(ARGS)).isError).toBeUndefined();
  });
});
