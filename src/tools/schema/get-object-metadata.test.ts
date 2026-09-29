// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import type { Logger } from '../../logger.js';
import { createGetObjectMetadataTool } from './get-object-metadata.js';
import { formFixture } from '../../ivanti/session/form.fixture.js';

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
const labelledTool = (
  fieldLabels: Record<string, string>,
  get?: () => Promise<never>,
  rules: { requiredRuleFields?: readonly string[]; readOnlyFields?: readonly string[] } = {},
) => {
  const { connection } = connectionFixture({
    entities: { incident: INCIDENT },
    capability: { tier: 'session' },
  });
  const forms = {
    get: get ?? (() => Promise.resolve(formFixture({ fieldLabels, ...rules }))),
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

/** The table's rows, header dropped, keyed by field name. */
const rowsOf = (body: Payload): Record<string, string> =>
  Object.fromEntries(
    (typeof body.fields === 'string' ? body.fields : '')
      .split('\n')
      .slice(1)
      .map((line) => [line.split('|')[0] ?? '', line]),
  );

describe('get_object_metadata', () => {
  it('reports fields with short types, and marks required and validated ones', async () => {
    const body = payload(await tool().handler({ object: 'Incident#' }));

    expect(body).toMatchObject({
      object: 'incident',
      entitySet: 'incidents',
      fields: [
        'name|type|label|flags',
        'RecId|String||required',
        'Subject|String',
        'Status|String||validated',
        'Priority|Int32',
      ].join('\n'),
      relationships: ['IncidentContainsTask → task'],
    });
    // The columns are explained once, beside them, rather than spelled out on every field.
    expect(body.fieldsFormat).toContain('name|type|label|flags');
  });

  it('folds a link into one row that keeps its label, its flags and all three names', async () => {
    const { connection } = connectionFixture({
      entities: {
        incident: {
          fields: [
            field('Subject'),
            field('ProfileLink'),
            field('ProfileLink_RecID', { nullable: false }),
            field('ProfileLink_Category'),
          ],
          relationships: [],
        },
      },
      capability: { tier: 'session' },
    });
    const linked = createGetObjectMetadataTool({
      connection: {
        ...connection,
        // The label sits on the `_RecID` half, as incident's "Customer" does.
        forms: { get: () => Promise.resolve(formFixture({ fieldLabels: { ProfileLink_RecID: 'Customer' } })) },
      },
      gate: OPEN_GATE,
      logger: logger(),
      ownRecordsOnly: false,
      actions: OPEN_ACTIONS,
    });

    const body = payload(await linked.handler({ object: 'incident' }));
    expect(String(body.fields).split('\n')).toEqual([
      'name|type|label|flags',
      'Subject|String',
      'ProfileLink|link|Customer|required',
    ]);
    // Four fields, in two rows.
    expect(body.fieldCount).toBe(4);
    expect(body.fieldsFormat).toContain('_RecID');

    // A search for the half a filter uses still finds the row it was folded into.
    const searched = payload(await linked.handler({ object: 'incident', search: 'profilelink_recid' }));
    expect(rowsOf(searched)).toHaveProperty('ProfileLink');
  });

  it("reports the tenant's own label for a field, which is the name a person is shown", async () => {
    const body = payload(await labelledTool({ Subject: 'Summary', Status: 'State' }).handler({ object: 'incident' }));

    expect(rowsOf(body)).toMatchObject({
      Subject: 'Subject|String|Summary',
      Status: 'Status|String|State|validated',
    });
  });

  it('omits a label that only repeats the field name, which most of them do', async () => {
    const body = payload(await labelledTool({ Subject: 'Subject', Status: 'State' }).handler({ object: 'incident' }));
    expect(rowsOf(body).Subject).toBe('Subject|String');
    expect(rowsOf(body).Status).toBe('Status|String|State|validated');
  });

  it('searches labels as well as names, or a caller told to say "Customer" cannot find it', async () => {
    const body = payload(
      await labelledTool({ Subject: 'Customer summary' }).handler({ object: 'incident', search: 'customer' }),
    );

    expect(body).toMatchObject({ fieldCount: 1 });
    expect(rowsOf(body).Subject).toBe('Subject|String|Customer summary');
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

describe('required and read-only rules', () => {
  const payloadOf = async (rules: { requiredRuleFields?: readonly string[]; readOnlyFields?: readonly string[] }) =>
    payload(await labelledTool({}, undefined, rules).handler({ object: 'Incident#' }));

  it("marks a governed field `required?`, which is weaker than the schema's own `required`", async () => {
    const rows = rowsOf(await payloadOf({ requiredRuleFields: ['Status', 'Priority'] }));

    expect(rows.Status).toBe('Status|String||required? validated');
    // RecId is nullable: false in the schema — an absolute answer, not a conditional one.
    expect(rows.RecId).toBe('RecId|String||required');
    // Untouched by any rule.
    expect(rows.Subject).toBe('Subject|String');
  });

  /**
   * Conditional, not absolute: a problem lists `Category` read-only and accepts it on a create,
   * and `Category` is the one field its schema calls mandatory.
   */
  it('marks a governed field `readOnly?` rather than claiming the write will fail', async () => {
    const rows = rowsOf(await payloadOf({ readOnlyFields: ['Priority'] }));

    expect(rows.Priority).toBe('Priority|Int32||readOnly?');
    expect(rows.Subject).toBe('Subject|String');
  });

  it('explains once that the two flags differ in kind', async () => {
    const note = (await payloadOf({ requiredRuleFields: ['Status'], readOnlyFields: ['Priority'] }))['rulesNote'];

    expect(note).toContain('never says which conditions');
    expect(note).toContain('never as "this write will be refused"');
  });

  it('says nothing when the form ships no rules', async () => {
    expect(await payloadOf({})).not.toHaveProperty('rulesNote');
  });
});
