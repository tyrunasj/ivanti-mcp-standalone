// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { parseLog, percentile, summarise } from './usage-report.js';

const finished = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    time: '2026-09-28T10:00:00.000Z',
    level: 'info',
    message: 'tool finished',
    outcome: 'ok',
    argsChars: 10,
    resultChars: 100,
    ivantiRequests: 1,
    ms: 50,
    ...fields,
  });

describe('parseLog', () => {
  it('reads our lines out of a log with anything else in it', () => {
    const log = [
      finished({ tool: 'list_records' }),
      // A collector's prefix in front of the JSON.
      `2026-09-28T10:00:01Z stdout F ${finished({ tool: 'get_record' })}`,
      JSON.stringify({ level: 'info', message: 'tool called', tool: 'get_record' }),
      JSON.stringify({ message: 'resource read', uri: 'ivanti://reference/queries', resultChars: 4000 }),
      'not json at all',
      '',
    ].join('\n');

    const parsed = parseLog(log);

    expect(parsed.tools.map((line) => line.tool)).toEqual(['list_records', 'get_record']);
    expect(parsed.resources).toEqual([{ uri: 'ivanti://reference/queries', resultChars: 4000 }]);
    expect(parsed.skipped).toBe(1);
  });

  it('counts an image in a result with the text it came with', () => {
    const parsed = parseLog(finished({ tool: 'download_attachment', resultChars: 20, nonTextChars: 5000 }));

    expect(parsed.tools[0]?.resultChars).toBe(5020);
  });
});

describe('summarise', () => {
  it('puts the tool that cost most first, with its spread', () => {
    const report = summarise(
      parseLog(
        [
          finished({ tool: 'get_version', resultChars: 50 }),
          finished({ tool: 'list_records', resultChars: 1000 }),
          finished({ tool: 'list_records', resultChars: 3000 }),
        ].join('\n'),
      ),
    );

    expect(report.tools.map((tool) => tool.tool)).toEqual(['list_records', 'get_version']);
    expect(report.tools[0]).toMatchObject({
      calls: 2,
      resultChars: { p50: 1000, max: 3000, total: 4000 },
    });
  });

  it('counts a retry as the same tool again, in the same conversation, right after it failed', () => {
    const report = summarise(
      parseLog(
        [
          finished({ time: '2026-09-28T10:00:01Z', sessionId: 'a', tool: 'list_records', outcome: 'UnsupportedFilterError', argsChars: 40, resultChars: 300 }),
          finished({ time: '2026-09-28T10:00:02Z', sessionId: 'a', tool: 'list_records' }),
          // Another conversation's failure followed by a different tool is not a retry.
          finished({ time: '2026-09-28T10:00:01Z', sessionId: 'b', tool: 'list_records', outcome: 'ivanti 400' }),
          finished({ time: '2026-09-28T10:00:03Z', sessionId: 'b', tool: 'get_object_metadata' }),
        ].join('\n'),
      ),
    );

    const listRecords = report.tools.find((tool) => tool.tool === 'list_records');
    expect(listRecords).toMatchObject({
      notOk: 2,
      retries: 1,
      retriedChars: 340,
      outcomes: { UnsupportedFilterError: 1, 'ivanti 400': 1 },
    });
    expect(report.conversations).toBe(2);
  });

  it('adds up how often each reference document was read', () => {
    const report = summarise(
      parseLog(
        [
          JSON.stringify({ message: 'resource read', uri: 'ivanti://reference/queries', resultChars: 4000 }),
          JSON.stringify({ message: 'resource read', uri: 'ivanti://reference/queries', resultChars: 4000 }),
        ].join('\n'),
      ),
    );

    expect(report.resources).toEqual([{ uri: 'ivanti://reference/queries', reads: 2, resultChars: 8000 }]);
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBe(0);
  });
});
