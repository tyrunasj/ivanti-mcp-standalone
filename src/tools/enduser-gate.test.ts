// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture, field } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { selectTools } from './register-tools.js';
import { createSessionPin } from '../auth/identity-pin.js';
import { ANONYMOUS } from '../auth/identity.js';
import type { CallContext } from './tool-definition.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const GATED = configFixture({
  MCP_MODE: 'enduser',
  ENDUSER_BUSINESS_OBJECTS: ['incident', 'change', 'servicereq'],
});

const PERSON = { RecId: 'e1', LoginID: 'JSmith', DisplayName: 'Jon Smith', Status: 'Active' };

const tools = (
  overrides: Partial<Parameters<typeof configFixture>[0]> = {},
  capability?: NonNullable<Parameters<typeof connectionFixture>[0]>['capability'],
) => {
  const { connection, urls } = connectionFixture({
    ...(capability === undefined ? {} : { capability }),
    entities: {
      incident: {
        fields: [
          field('RecId'),
          field('Subject'),
          field('Status'),
          field('ProfileLink_RecID'),
          field('ProfileLink_Category'),
        ],
        relationships: [
          { name: 'IncidentOwnerEmployee', target: 'employee' },
          { name: 'IncidentContainsJournal', target: 'journal' },
        ],
      },
      change: {},
      servicereq: {},
      employee: {},
      frs_hc_calllog: {},
    },
    responses: {
      // Every incident here belongs to the person the tests act as, so a scoped read has
      // something to return.
      incidents: {
        value: [
          { RecId: 'i1', Subject: 'Printer', ProfileLink_RecID: 'e1', ProfileLink_Category: 'Employee' },
        ],
      },
      employees: { value: [PERSON] },
    },
  });
  const selected = selectTools(
    Object.keys(overrides).length === 0
      ? GATED
      : configFixture({
          MCP_MODE: 'enduser',
          ENDUSER_BUSINESS_OBJECTS: ['incident', 'change', 'servicereq'],
          ...overrides,
        }),
    {
    serverName: 'ivanti-mcp',
    serverVersion: '0.1.0',
    logger: logger(),
      ivanti: connection,
    },
  );
  const byName = new Map(selected.map((tool) => [tool.name, tool]));
  const tool = (name: string) => byName.get(name)!;

  // One conversation, so `act_as` and everything after it share a pin.
  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
  const actAs = async (person = 'JSmith'): Promise<void> => {
    const result = await tool('act_as').handler({ person }, context);
    if (result.isError === true) throw new Error(text(result));
  };

  return { urls, tool, context, actAs, names: selected.map((entry) => entry.name) };
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

  it('still serves the allowed objects, once it knows who is asking', async () => {
    const { tool, context, actAs } = tools();
    await actAs();

    const result = await tool('list_records').handler({ object: 'Incidents' }, context);

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('"returned": 1');
    // The answer says whose records these are, rather than implying they are everyone's.
    expect(text(result)).toContain('"scopedTo": "Jon Smith"');
  });

  /**
   * The constraint has to reach the REQUEST, not merely be computed.
   *
   * `scopeToOwnRecords` was unit-tested on the string it returns, and the gate tests asserted on
   * the rows that came back — but the fixture matches responses by URL substring and hands back
   * its incident regardless of `$filter`, so `returned: 1` and `scopedTo` both survive the
   * constraint being dropped. Removing it from all five call sites left 767/767 green and
   * typecheck clean. In enduser mode a collection read has NO post-read ownership check, so the
   * filter IS the boundary.
   */
  it.each([
    ['list_records', { object: 'Incidents' }],
    ['count_records', { object: 'Incidents' }],
    ['fulltext_search_object', { object: 'Incidents', query: 'printer' }],
    ['group_count', { object: 'Incidents', groupBy: 'Status', values: ['Active'] }],
  ])('puts the own-records constraint in the URL %s sends', async (name, args) => {
    const { tool, context, actAs, urls } = tools({}, { tier: 'session', identity: { role: 'x' } });
    await actAs();
    urls.length = 0;

    await tool(name).handler(args, context);

    // `customer-link` samples rows to learn which field holds a person, and that probe is
    // deliberately unscoped — it is asking what the OBJECT looks like, not what the caller owns.
    // The reads that answer the caller are the ones carrying a filter.
    const reads = urls
      .filter((url) => url.includes('incidents'))
      .map((url) => decodeURIComponent(url))
      .filter((url) => url.includes('$filter='));

    expect(reads.length, `${name} sent no filtered read at all`).toBeGreaterThan(0);
    for (const url of reads) {
      expect(url, `${name} sent an unscoped read`).toContain("ProfileLink_RecID eq 'e1'");
    }
  });

  it('refuses a relationship that reaches a gated object', async () => {
    // The allowlist guards the object you NAME; without this it did not guard the object you
    // REACH. Measured on a live tenant: `IncidentOwnerEmployee` from an allowed incident handed
    // back the owning analyst's login and email, on a deployment that refuses `Employees`.
    const { tool, context, actAs } = tools();
    await actAs();

    const result = await tool('get_related_records').handler(
      { object: 'Incidents', recordId: 'i1', relationship: 'IncidentOwnerEmployee' },
      context,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('leads to employee records');
  });

  it('points at list_notes when a relationship reaches the journal', async () => {
    // Journals carry staff-internal notes on the caller's own ticket, which `list_notes` filters
    // and a raw traversal does not.
    const { tool, context, actAs } = tools();
    await actAs();

    const result = await tool('get_related_records').handler(
      { object: 'Incidents', recordId: 'i1', relationship: 'IncidentContainsJournal' },
      context,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('list_notes');
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
    const { tool, context, actAs } = tools();
    await actAs();

    const body = JSON.parse(text(await tool('search').handler({ query: 'printer' }, context))) as {
      searched: string[];
      skipped?: { object: string; reason: string }[];
    };

    // Every allowed object is attempted — the gate narrows the fan-out, it does not refuse the
    // call. `searched` now lists only the ones that actually answered: an object that failed is
    // reported under `skipped` alone, because saying both at once told the reader two
    // contradictory things and the reassuring one is the one that gets believed.
    const attempted = [...body.searched, ...(body.skipped ?? []).map((entry) => entry.object)];
    expect(attempted.sort()).toEqual(['changes', 'incidents', 'servicereqs']);
    expect(body.searched).not.toEqual(
      expect.arrayContaining((body.skipped ?? []).map((entry) => entry.object)),
    );
  });

  it('refuses a search aimed at a gated object', async () => {
    const { tool } = tools();

    // Refused on the gate before the identity is ever needed: a gated object is not confirmed
    // to exist, whoever is asking.
    const body = JSON.parse(
      text(await tool('search').handler({ query: 'x', objects: ['Employees'] })),
    ) as { results: unknown[]; note?: string };

    expect(body.results).toEqual([]);
    expect(body.note).toContain('incident, change, servicereq');
  });

  it('does not offer the tools that answer for someone other than the caller', () => {
    const { names } = tools();

    // A saved search called "My …" records the *service account's* work, and assigned work asks
    // who is working a record rather than who it is for. Narrowing them would not make either
    // one mean what an end user would read it to mean, so they are not registered at all.
    for (const absent of [
      'list_assigned_work',
      'list_saved_searches',
      'saved_search',
      'preview_delete',
      'link_records',
      'unlink_records',
    ]) {
      expect(names, `${absent} should not exist in enduser mode`).not.toContain(absent);
    }
  });

  /**
   * The three quick-action tools are absent only because this fixture names no actions.
   *
   * They used to sit in the list above, which asserted they should not exist in `enduser` mode at
   * all — and a real deployment that sets `ENDUSER_QUICK_ACTIONS` registers them, which is the
   * shape CLAUDE.md documents as the supported way to let end users close their own tickets. The
   * assertion was not merely incomplete, it was false.
   */
  it('registers the quick-action tools exactly when ENDUSER_QUICK_ACTIONS names something', () => {
    const quickActions = ['list_quick_actions', 'preview_quick_action', 'run_quick_action'];

    const { names: withNone } = tools({}, { tier: 'session', identity: { role: 'SelfService' } });
    for (const name of quickActions) {
      expect(withNone, `${name} must not exist when no action is allowed`).not.toContain(name);
    }

    // The session tier as well: these live on a workspace or a create form, which OData cannot
    // reach, so `register-tools.ts:116` gates them on that first.
    const { names: withSome } = tools(
      { ENDUSER_QUICK_ACTIONS: ['Close From Self Service'] },
      { tier: 'session', identity: { role: 'SelfService' } },
    );
    for (const name of quickActions) {
      expect(withSome, `${name} must exist when an action is allowed`).toContain(name);
    }
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
