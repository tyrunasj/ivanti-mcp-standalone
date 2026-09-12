import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import type { Logger } from '../../logger.js';
import { createGetServiceRequestParameterOptionsTool } from './get-service-request-parameter-options.js';
import { createGetServiceRequestParametersTool } from './get-service-request-parameters.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const body = (result: CallToolResult): Record<string, never> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, never>;
};

const tools = (responses: Record<string, unknown>) => {
  const { connection, urls } = connectionFixture({ responses });
  const deps = { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS };
  return {
    urls,
    parameters: createGetServiceRequestParametersTool(deps),
    options: createGetServiceRequestParameterOptionsTool(deps),
  };
};

describe('get_service_request_parameters', () => {
  it('decodes the required expression instead of trusting its truthiness', async () => {
    const { parameters } = tools({
      servicereqtemplateparams: {
        value: [
          { RecId: 'p1', Name: 'StartDate', RequiredExpression: 'true', SequenceNum: 0 },
          { RecId: 'p2', Name: 'ReturnDate', RequiredExpression: '$(false)', SequenceNum: 1 },
          { RecId: 'p3', Name: 'Extra', RequiredExpression: '$(Status)', SequenceNum: 2 },
        ],
      },
    });

    const result = body(await parameters.handler({ templateId: 't1' }));
    const rows = result.parameters as unknown as Record<string, unknown>[];

    expect(rows[0]?.required).toBe(true);
    expect(rows[1]?.required).toBe(false);
    // A conditional rule is unknowable here, and "unknown" must not read as "not required".
    expect(rows[2]?.required).toBeUndefined();
  });

  it('filters by the template link and asks in form order', async () => {
    const { parameters, urls } = tools({ servicereqtemplateparams: { value: [] } });

    await parameters.handler({ templateId: "O'Brien" });

    expect(urls[0]).toContain('ParentLink_RecID%20eq%20');
    expect(urls[0]).toContain("O''Brien");
    expect(urls[0]).toContain('$orderby=SequenceNum');
  });

  it('names the likeliest mistake when nothing comes back', async () => {
    const { parameters } = tools({});

    const result = body(await parameters.handler({ templateId: 'wrong' }));

    expect(result.returned).toBe(0);
    expect(String(result.note)).toContain('subscription');
  });
});

describe('get_service_request_parameter_options', () => {
  it('POSTs to the validation list and shapes the rows into options', async () => {
    const { options, urls } = tools({
      ValidationList: [
        ['r1', 'Accounting', 'Accounting'],
        ['r2', 'IT'],
        ['r3', ''],
        'not a row',
      ],
    });

    const result = body(await options.handler({ parameterId: 'p1' }));

    expect(result.options).toEqual([
      { recId: 'r1', value: 'Accounting', label: 'Accounting' },
      { recId: 'r2', value: 'IT', label: 'IT' },
    ]);
    expect(urls[0]).toContain('/api/rest/ServiceRequest/p1/ValidationList');
  });

  it('explains an empty list rather than presenting it as complete', async () => {
    const { options } = tools({ ValidationList: [] });

    const result = body(await options.handler({ parameterId: 'p1' }));

    expect(result.returned).toBe(0);
    expect(String(result.note)).toContain('constraints');
  });
});
