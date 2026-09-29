// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture, field } from '../../ivanti/connection.fixture.js';
import { IvantiApiError } from '../../ivanti/http/errors.js';
import type { Logger } from '../../logger.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
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
  return { urls, deps: { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS } };
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
    const patches = urls.filter((url) => url.startsWith('PATCH'));
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain("incidents('abc')/IncidentContainsTask('t1')/$Ref");
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

  it('answers “already linked” when the link is already there, and changes nothing', async () => {
    const { deps: d, urls } = deps({ IncidentAssociatesCI: { value: [{ RecId: 'CI9' }] } });

    const result = body(
      await createLinkRecordsTool(d).handler({
        ...ARGS,
        relationship: 'IncidentAssociatesCI',
        targetId: 'ci9',
      }),
    );

    // Not a refusal — a batch re-run after a partial failure depends on this answering cleanly.
    expect(result).toMatchObject({ alreadyLinked: true, targetId: 'ci9' });
    expect(result).not.toHaveProperty('linked');
    expect(urls.some((url) => url.startsWith('PATCH'))).toBe(false);
  });
});

/**
 * A parent/child relationship moves the child rather than adding to it.
 *
 * The child holds its parent in its own `ParentLink_RecID`, so it has exactly one. Linking a task
 * that belongs to change C9 under incident `abc` does not give it two parents — it takes it off
 * C9, which Ivanti answers with ISM_2000 and nothing in the reply mentions. The tool is annotated
 * non-destructive, so it must refuse that rather than do it.
 */
describe('link_records on a Contains relationship', () => {
  const TASK = entityFixture('task', {
    fields: [field('RecId'), field('ParentLink_RecID'), field('ParentLink_Category')],
  });
  const CHANGE = entityFixture('change', {
    relationships: [{ name: 'ChangeContainsTask', target: 'task' }],
  });

  function setup(responses: Record<string, unknown>) {
    const { connection, urls } = connectionFixture({
      entities: { incident: INCIDENT, task: TASK, change: CHANGE },
      responses,
    });
    return {
      urls,
      connection,
      link: createLinkRecordsTool({
        connection,
        gate: OPEN_GATE,
        logger: logger(),
        ownRecordsOnly: false,
        actions: OPEN_ACTIONS,
      }),
    };
  }

  /** The task as read before the PATCH, then after it — the fixture alone answers one thing. */
  function readsInTurn(connection: ReturnType<typeof setup>['connection'], rows: unknown[]): void {
    const original = connection.transport.request.bind(connection.transport);
    vi.spyOn(connection.transport, 'request').mockImplementation(((
      url: string,
      init?: { method?: string },
    ) =>
      url.includes("tasks('t1')") && (init?.method ?? 'GET') === 'GET'
        ? Promise.resolve(rows.shift())
        : original(url, init)));
  }

  const OK = { 'PATCH IncidentContainsTask': { code: 'ISM_2000' } };

  it('refuses to move a child off the parent it already has, and says how to move it', async () => {
    const { link, urls } = setup({
      ...OK,
      "tasks('t1')": { RecId: 't1', ParentLink_RecID: 'C9', ParentLink_Category: 'Change' },
    });

    const result = await link.handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('already belongs to Change C9');
    expect(text(result)).toContain('silently MOVE it');
    // Runnable, not just described: the parent's own Contains relationship, from its metadata.
    expect(text(result)).toContain(
      "unlink_records({ object: 'Change', recordId: 'C9', relationship: 'ChangeContainsTask', targetId: 't1' })",
    );
    expect(urls.some((url) => url.startsWith('PATCH'))).toBe(false);
  });

  it('answers “already linked” when the child already has this parent', async () => {
    const { link, urls } = setup({
      ...OK,
      "tasks('t1')": { RecId: 't1', ParentLink_RecID: 'ABC', ParentLink_Category: 'Incident' },
    });

    const result = body(await link.handler(ARGS));

    expect(result).toMatchObject({ alreadyLinked: true, targetId: 't1' });
    expect(result).not.toHaveProperty('linked');
    expect(String(result.note)).toContain('Nothing was changed');
    expect(urls.some((url) => url.startsWith('PATCH'))).toBe(false);
  });

  it('links a child that has no parent, and reads the child back to confirm it', async () => {
    const { link, connection, urls } = setup(OK);
    readsInTurn(connection, [
      { RecId: 't1', ParentLink_RecID: null, ParentLink_Category: null },
      { RecId: 't1', ParentLink_RecID: 'abc', ParentLink_Category: 'Incident' },
    ]);

    const result = body(await link.handler(ARGS));

    expect(result).toMatchObject({ linked: 't1' });
    expect(urls.filter((url) => url.startsWith('PATCH'))).toHaveLength(1);
  });

  it('reports a link Ivanti answered with success but did not make', async () => {
    const { link, connection } = setup(OK);
    readsInTurn(connection, [
      { RecId: 't1', ParentLink_RecID: null },
      { RecId: 't1', ParentLink_RecID: null },
    ]);

    const result = await link.handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('NOT linked');
  });

  it('refuses a child that does not exist before sending anything', async () => {
    const { link, urls } = setup({
      ...OK,
      "tasks('t1')": new IvantiApiError(
        { status: 400, method: 'GET', url: 'tasks', body: '{"code":"ISM_4000","description":"Invalid key"}' },
      ),
    });

    const result = await link.handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No tasks record with RecId t1');
    expect(urls.some((url) => url.startsWith('PATCH'))).toBe(false);
  });

  it('refuses rather than links when the child’s parent cannot be read', async () => {
    // A guard that cannot be evaluated must refuse the write, not switch itself off.
    const { link, urls } = setup({
      ...OK,
      "tasks('t1')": new IvantiApiError({ status: 500, method: 'GET', url: 'tasks' }),
    });

    const result = await link.handler(ARGS);

    expect(result.isError).toBe(true);
    expect(urls.some((url) => url.startsWith('PATCH'))).toBe(false);
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
