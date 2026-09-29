// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { OPEN_GATE, type ObjectGate } from '../shared/object-gate.js';
import type { CallContext } from '../tool-definition.js';
import { createGetServiceRequestParametersTool } from './get-service-request-parameters.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};
const body = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(text(result) || '{}') as Record<string, unknown>;

function pinned(): CallContext {
  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
  context.pin?.pin({
    recId: 'E1',
    category: 'employee',
    displayName: 'Harold Sanders',
    loginId: 'HSanders',
    matchedOn: 'LoginID',
    provenance: 'asserted',
  });
  return context;
}

function setup(
  responses: Record<string, unknown>,
  options: { ownRecordsOnly?: boolean; gate?: ObjectGate } = {},
) {
  const { connection, urls } = connectionFixture({
    entities: {
      servicereq: {
        fields: [field('RecId'), field('ProfileLink_RecID'), field('ProfileLink_Category')],
      },
      employee: {},
    },
    responses,
  });
  return {
    urls,
    connection,
    parameters: createGetServiceRequestParametersTool({
      connection,
      gate: options.gate ?? OPEN_GATE,
      logger: logger(),
      ownRecordsOnly: options.ownRecordsOnly ?? false,
      actions: OPEN_ACTIONS,
    }),
  };
}

const parameter = (n: number): Record<string, unknown> => ({
  RecId: `p${String(n)}`,
  Name: `Q${String(n)}`,
  SequenceNum: n,
});

/** Serves a long collection a page at a time, by `$skip`, the way Ivanti does. */
function paged(
  connection: ReturnType<typeof setup>['connection'],
  total: number,
  withCount = true,
): void {
  const original = connection.transport.request.bind(connection.transport);
  vi.spyOn(connection.transport, 'request').mockImplementation(((url: string, init?: unknown) => {
    if (!url.includes('servicereqtemplateparams')) return original(url, init as never);
    const skip = Number(/\$skip=(\d+)/.exec(url)?.[1] ?? 0);
    const value = Array.from({ length: Math.max(0, Math.min(100, total - skip)) }, (_, i) =>
      parameter(skip + i),
    );
    return Promise.resolve(withCount ? { '@odata.count': total, value } : { value });
  }));
}

describe('get_service_request_parameters, a form longer than one page', () => {
  it('reads past the first 100 parameters instead of silently dropping the rest', async () => {
    const { parameters, connection } = setup({});
    paged(connection, 150);

    const result = body(await parameters.handler({ templateId: 't1' }));

    expect(result).toMatchObject({ returned: 150, total: 150, hasMore: false });
    expect(result).not.toHaveProperty('hasMoreNote');
  });

  it('says when even the page limit is not the end of it', async () => {
    const { parameters, connection } = setup({});
    paged(connection, 700);

    const result = body(await parameters.handler({ templateId: 't1' }));

    expect(result).toMatchObject({ returned: 500, total: 700, hasMore: true });
    expect(String(result['hasMoreNote'])).toContain('first 500 parameters were read of 700');
  });

  it('keeps reading on a full page when Ivanti sends no count, and stops on a short one', async () => {
    const { parameters, connection } = setup({});
    paged(connection, 130, false);

    const result = body(await parameters.handler({ templateId: 't1' }));

    expect(result).toMatchObject({ returned: 130, total: 130, hasMore: false });
  });

  it('reports the total and no cut-off on a form that fits one page', async () => {
    const { parameters } = setup({
      servicereqtemplateparams: { '@odata.count': 2, value: [parameter(1), parameter(2)] },
    });

    const result = body(await parameters.handler({ templateId: 't1' }));

    expect(result).toMatchObject({ returned: 2, total: 2, hasMore: false });
  });
});

describe('get_service_request_parameters, the other branches', () => {
  it('asks for an id when given neither', async () => {
    const { parameters, urls } = setup({});

    const result = await parameters.handler({});

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('`templateId`');
    expect(urls).toEqual([]);
  });

  it('refuses where service requests are not exposed at all', async () => {
    const gate: ObjectGate = { allowed: ['incident'], allows: (ref) => ref.toLowerCase() === 'incident' };
    const { parameters, urls } = setup({}, { gate });

    const result = await parameters.handler({ templateId: 't1' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("'ServiceReq' is not one of them");
    expect(urls).toEqual([]);
  });

  it('counts section headings apart from questions', async () => {
    const { parameters } = setup({
      servicereqtemplateparams: {
        value: [
          { RecId: 'h1', Name: 'Details', DisplayType: 'category' },
          { RecId: 'p1', Name: 'Reason', DisplayType: 'text' },
        ],
      },
    });

    const result = body(await parameters.handler({ templateId: 't1' }));

    expect(result).toMatchObject({ returned: 2, answerable: 1 });
    expect(String(result['answerableNote'])).toContain('section headings');
  });

  it('projects the fields asked for instead of the default set', async () => {
    const { parameters } = setup({
      servicereqtemplateparams: {
        value: [{ RecId: 'p1', Name: 'Reason', DisplayType: 'text', Description: 'Why' }],
      },
    });

    const result = body(await parameters.handler({ templateId: 't1', fields: 'Name' }));
    const [first] = result['parameters'] as Record<string, unknown>[];

    expect(first).toMatchObject({ Name: 'Reason' });
    expect(first).not.toHaveProperty('Description');
  });

  it('reads the answers on a request, with a date given as the local day chosen', async () => {
    // Stored as the UTC instant of local midnight, so on a UTC+2 tenant 1 October reads back as
    // 30 September 22:00 — and narrating that verbatim names the wrong day.
    const { parameters } = setup({
      servicereqparams: {
        '@odata.count': 2,
        value: [
          {
            ParameterName: 'StartDate',
            ParameterValue: '2026-09-30T22:00:00Z',
            ParameterDisplayValue: '2026-09-30T22:00:00Z',
            DisplayType: 'date',
          },
          { ParameterName: 'Reason', ParameterValue: 'New starter', DisplayType: 'text' },
        ],
      },
      // The newest row the tenant offset is read from.
      servicereqs: { value: [{ RecId: 'sr9', LastModDateTime: '2026-09-28T10:00:00+02:00' }] },
    });

    const result = body(await parameters.handler({ requestId: 'sr1' }));

    expect(result).toMatchObject({ requestId: 'sr1', returned: 2, total: 2, hasMore: false });
    expect(result['answers']).toEqual([
      { parameter: 'StartDate', displayValue: '2026-10-01', value: '2026-09-30T22:00:00Z', type: 'date' },
      { parameter: 'Reason', displayValue: 'New starter', value: 'New starter', type: 'text' },
    ]);
  });

  it('shows the raw value when the tenant offset cannot be read', async () => {
    const { parameters } = setup({
      servicereqparams: {
        value: [{ ParameterName: 'StartDate', ParameterValue: 'not a date', DisplayType: 'date' }],
      },
    });

    const result = body(await parameters.handler({ requestId: 'sr1' }));

    expect((result['answers'] as Record<string, unknown>[])[0]?.['displayValue']).toBe('not a date');
  });

  it('refuses an end user the answers on someone else’s request', async () => {
    const { parameters, urls } = setup(
      {
        "servicereqs('sr1')": { RecId: 'sr1', ProfileLink_RecID: 'SOMEONE-ELSE' },
        servicereqs: { value: [{ ProfileLink_RecID: 'E1', ProfileLink_Category: 'Employee' }] },
        servicereqparams: { value: [{ ParameterName: 'Salary', ParameterValue: '100' }] },
      },
      { ownRecordsOnly: true },
    );

    const result = await parameters.handler({ requestId: 'sr1' }, pinned());

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('No such record is available to you.');
    expect(urls.some((url) => url.includes('servicereqparams'))).toBe(false);
  });
});
