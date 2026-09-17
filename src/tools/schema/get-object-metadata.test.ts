// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

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

/**
 * A tenant whose form labels some of its fields.
 *
 * `forms` is stubbed rather than driven through `sessionCalls`: what is under test is which name
 * this tool reports, not how `form-context` walks workspace → layout → view, which owns that
 * question and its own tests. The tier has to leave `odata`, because a form needs a session.
 */
const labelledTool = (fieldLabels: Record<string, string>, get?: () => Promise<never>) => {
  const { connection } = connectionFixture({
    entities: { incident: INCIDENT },
    capability: { tier: 'session' },
  });
  const forms = {
    get: get ?? (() => Promise.resolve({ layoutName: 'l', viewName: 'v', formName: 'f', validatedFields: {}, displayNames: {}, fieldLabels, linkFields: {} })),
  };
  return createGetObjectMetadataTool({
    connection: { ...connection, forms },
    gate: OPEN_GATE,
    logger: logger(),
    ownRecordsOnly: false,
    actions: OPEN_ACTIONS,
  });
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

  it("reports the tenant's own label for a field, which is the name a person is shown", async () => {
    const body = payload(await labelledTool({ Subject: 'Summary', Status: 'State' }).handler({ object: 'incident' }));

    expect(body.fields).toMatchObject([
      { name: 'RecId' },
      { name: 'Subject', label: 'Summary' },
      { name: 'Status', label: 'State' },
      { name: 'Priority' },
    ]);
  });

  it('omits a label that only repeats the field name, which most of them do', async () => {
    const body = payload(await labelledTool({ Subject: 'Subject', Status: 'State' }).handler({ object: 'incident' }));
    const fields = body.fields as Record<string, unknown>[];

    expect(fields.find((f) => f.name === 'Subject')).not.toHaveProperty('label');
    expect(fields.find((f) => f.name === 'Status')).toHaveProperty('label', 'State');
  });

  it('searches labels as well as names, or a caller told to say "Customer" cannot find it', async () => {
    const body = payload(
      await labelledTool({ Subject: 'Customer summary' }).handler({ object: 'incident', search: 'customer' }),
    );

    expect(body).toMatchObject({ fieldCount: 1, fields: [{ name: 'Subject', label: 'Customer summary' }] });
  });

  it('says WHY there are no labels, because the caller is told to prefer them', async () => {
    // No session: the difference between "this object has no labels" and "this credential cannot
    // see labels" is the difference between a safe fallback and a silently worse answer.
    const noSession = payload(await tool().handler({ object: 'incident' }));
    expect(noSession.labelsNote).toContain('cannot read');

    const noLabels = payload(await labelledTool({}).handler({ object: 'incident' }));
    expect(noLabels.labelsNote).toContain('only names it has here');

    const labelled = payload(await labelledTool({ Subject: 'Summary' }).handler({ object: 'incident' }));
    expect(labelled).not.toHaveProperty('labelsNote');
  });

  it('still answers when the form lookup fails, because the fields are the answer', async () => {
    const body = payload(
      await labelledTool({}, () => Promise.reject(new Error('ASMX said no'))).handler({ object: 'incident' }),
    );

    // And the failure is reported as "no labels", not swallowed into "labels exist but are equal":
    // that note is how the caller knows it may fall back to the key.
    expect(body).toMatchObject({ object: 'incident', fieldCount: 4 });
    expect(body.labelsNote).toContain('only names it has here');
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
