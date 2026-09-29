// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import type { ToolLine } from './usage-report.js';
import { analyseWaste, callCost } from './waste.js';

let clock = 0;
const call = (fields: Partial<ToolLine> & { tool: string }): ToolLine => ({
  time: `2026-09-29T10:00:${String(clock++).padStart(2, '0')}Z`,
  conversation: 'c1',
  manifest: 'v1',
  manifestChars: 1000,
  client: 'claude-ai/1.0',
  outcome: 'ok',
  argsChars: 10,
  resultChars: 100,
  ivantiRequests: 1,
  ms: 5,
  ...fields,
});

describe('callCost', () => {
  it('prices a call as the request it needed plus its own text re-sent after it', () => {
    // The manifest, the 300 characters before it, and its own 110 re-sent on 2 later requests.
    expect(callCost(1000, 300, call({ tool: 'list_records' }), 2)).toBe(1000 + 300 + 220);
  });
});

describe('analyseWaste', () => {
  it('names a refused call, prices it, and says whether the next call recovered', () => {
    const waste = analyseWaste([
      call({ tool: 'list_records', outcome: 'UnsupportedFilterError', argsHash: 'a' }),
      call({ tool: 'list_records', argsHash: 'b', rowsRead: 3 }),
    ]);

    // Refused first of two calls: its request (manifest, nothing before) and its 110 characters
    // re-sent on the two requests after it.
    expect(waste.patterns.failed).toEqual({ calls: 1, chars: 1000 + 0 + 110 * 2 });
    expect(waste.recovery).toEqual([{ outcome: 'UnsupportedFilterError', seen: 1, recovered: 1, sameAgain: 0 }]);
    expect(waste.wastedCalls).toBe(1);
    // Three requests: before each call, and the final answer.
    expect(waste.volume).toBe(1000 + (1000 + 110) + (1000 + 220));
  });

  it('counts the same refusal straight after itself as a message that did not help', () => {
    const waste = analyseWaste([
      call({ tool: 'list_records', outcome: 'FieldNameError' }),
      call({ tool: 'list_records', outcome: 'FieldNameError' }),
      call({ tool: 'list_records' }),
    ]);

    expect(waste.sameRefusalAgain).toBe(1);
    expect(waste.recovery[0]).toMatchObject({ seen: 2, recovered: 1, sameAgain: 1 });
  });

  it('counts an empty answer asked again differently, but not one taken at its word', () => {
    const asked = analyseWaste([
      call({ tool: 'search', rowsRead: 0, argsHash: 'a' }),
      call({ tool: 'search', rowsRead: 4, argsHash: 'b' }),
    ]);
    const accepted = analyseWaste([
      call({ tool: 'search', rowsRead: 0, argsHash: 'a', conversation: 'c2' }),
      call({ tool: 'get_record', argsHash: 'x', conversation: 'c2' }),
    ]);

    expect(asked.patterns.emptyThenAskedAgain.calls).toBe(1);
    expect(accepted.patterns.emptyThenAskedAgain.calls).toBe(0);
    // Moving to another tool after nothing came back is a switch worth seeing.
    expect(accepted.switches).toEqual([{ from: 'search', to: 'get_record', count: 1 }]);
  });

  it('counts an identical call made again later in the same conversation', () => {
    const waste = analyseWaste([
      call({ tool: 'get_record', argsHash: 'same' }),
      call({ tool: 'list_notes', argsHash: 'n' }),
      call({ tool: 'get_record', argsHash: 'same' }),
    ]);

    expect(waste.patterns.repeated.calls).toBe(1);
  });

  it('notices a conversation that ended on a failure', () => {
    const waste = analyseWaste([
      call({ tool: 'act_as' }),
      call({ tool: 'list_records', outcome: 'ivanti 400' }),
    ]);

    expect(waste.endedOnFailure).toBe(1);
  });

  it('counts the lookups made before the first real answer', () => {
    const waste = analyseWaste([
      call({ tool: 'act_as' }),
      call({ tool: 'list_business_objects' }),
      call({ tool: 'get_object_metadata' }),
      call({ tool: 'list_records' }),
      call({ tool: 'get_object_metadata' }),
    ]);

    expect(waste.lookupsBeforeAnswer).toMatchObject({ p50: 2, max: 2 });
  });

  it('does not take a refused query for the first answer', () => {
    const waste = analyseWaste([
      call({ tool: 'list_records', outcome: 'UnsupportedFilterError' }),
      call({ tool: 'get_object_metadata' }),
      call({ tool: 'list_records' }),
    ]);

    expect(waste.lookupsBeforeAnswer.max).toBe(1);
  });

  it('does not count the identity gate as two tools a model could not tell apart', () => {
    const waste = analyseWaste([
      call({ tool: 'list_records', outcome: 'IdentityRequiredError' }),
      call({ tool: 'act_as' }),
    ]);

    expect(waste.switches).toEqual([]);
  });

  it('puts two versions of the instructions side by side', () => {
    const waste = analyseWaste([
      call({ tool: 'list_records', outcome: 'UnsupportedFilterError', conversation: 'old', manifest: 'v1' }),
      call({ tool: 'list_records', conversation: 'old', manifest: 'v1' }),
      call({ tool: 'list_records', conversation: 'new', manifest: 'v2' }),
    ]);

    expect(waste.versions.map((v) => [v.manifest, v.failedShare])).toEqual([
      ['v1', 0.5],
      ['v2', 0],
    ]);
    expect(waste.versions.find((v) => v.manifest === 'v2')?.wasteShare).toBe(0);
  });

  it('says when a server too old to report its manifest size leaves that out of the cost', () => {
    const legacy: ToolLine = call({ tool: 'list_records' });
    delete legacy.manifestChars;

    expect(analyseWaste([legacy]).manifestKnown).toBe(false);
  });
});
