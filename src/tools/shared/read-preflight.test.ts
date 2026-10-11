// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import { IvantiApiError } from '../../ivanti/http/errors.js';
import type { Logger } from '../../logger.js';
import { createCountRecordsTool } from '../records/count-records.js';
import { createGroupCountTool } from '../records/group-count.js';
import { createListRecordsTool } from '../records/list-records.js';
import { createFulltextSearchObjectTool } from '../search/fulltext-search-object.js';
import { ANONYMOUS } from '../../auth/identity.js';
import { IdentityRequiredError, createSessionPin } from '../../auth/identity-pin.js';
import type { CallContext } from '../tool-definition.js';
import { FieldNameError } from './explain-field-error.js';
import { prepareFilterRead } from './read-preflight.js';
import { resolveObject } from './resolve-object.js';
import { OPEN_ACTIONS } from './action-gate.js';
import { OPEN_GATE } from './object-gate.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const INCIDENT = {
  fields: [
    field('RecId'),
    field('Subject'),
    field('Status', { validated: true }),
    field('ScheduledStartDate', { type: 'Edm.DateTimeOffset' }),
  ],
};

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};

const fixture = (responses: Record<string, unknown> = {}) => {
  const { connection, urls } = connectionFixture({ entities: { incident: INCIDENT }, responses });
  return {
    urls,
    deps: { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS },
  };
};

/** Every tool that takes the same `filter` argument, driven the same way. */
const TOOLS = [
  ['list_records', createListRecordsTool, {}],
  ['count_records', createCountRecordsTool, {}],
  ['fulltext_search_object', createFulltextSearchObjectTool, { query: 'printer' }],
  ['group_count', createGroupCountTool, { groupBy: 'Status', values: ['Active'] }],
] as const;

describe.each(TOOLS)('%s takes the filter checks list_records takes', (_name, create, extra) => {
  it('refuses `$NULL` on a date field by name, with no request sent', async () => {
    const { deps, urls } = fixture({});

    const result = await create(deps).handler({
      object: 'Incidents',
      filter: "ScheduledStartDate eq '$NULL'",
      ...extra,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("'ScheduledStartDate' is a DateTimeOffset field");
    expect(urls).toHaveLength(0);
  });

  it('names a misspelt filter field when Ivanti answers 400 "No such entry exists"', async () => {
    const { deps } = fixture({
      incidents: new IvantiApiError({
        status: 400,
        method: 'GET',
        url: 'u',
        body: '{"message":"No such entry exists"}',
      }),
    });

    const result = await create(deps).handler({
      object: 'Incidents',
      filter: "Statuss eq 'Active'",
      ...extra,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("has no field named 'Statuss' (did you mean: Status?)");
  });
});

describe('prepareFilterRead', () => {
  it('refuses an unidentified caller for that, before it explains any field', async () => {
    const { deps } = fixture({});
    const enduser = { ...deps, ownRecordsOnly: true };
    const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
    const resolved = await resolveObject(enduser, 'Incidents');

    await expect(
      prepareFilterRead(enduser, context, resolved, {
        filter: "ScheduledStartDate eq '$NULL'",
        orderBy: 'Nope asc',
      }),
    ).rejects.toBeInstanceOf(IdentityRequiredError);
  });

  it('checks the sort clause, then the $NULL types', async () => {
    const { deps } = fixture({});
    const context: CallContext = { identity: ANONYMOUS };
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(
      prepareFilterRead(deps, context, resolved, { orderBy: 'Nope asc' }),
    ).rejects.toThrow(/no field named 'Nope'/);
    await expect(
      prepareFilterRead(deps, context, resolved, { filter: "ScheduledStartDate eq '$NULL'" }),
    ).rejects.toBeInstanceOf(FieldNameError);
  });
});
