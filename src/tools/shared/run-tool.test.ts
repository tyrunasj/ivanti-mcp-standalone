// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import type { Logger, LogLevel } from '../../logger.js';
import { IvantiApiError } from '../../ivanti/http/errors.js';
import { runTool } from './run-tool.js';

interface Line {
  level: LogLevel;
  message: string;
  fields?: Record<string, unknown>;
}

const recorder = (): { logger: Logger; lines: Line[] } => {
  const lines: Line[] = [];
  const at =
    (level: LogLevel) =>
    (message: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    };
  return {
    lines,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
};

const failWith = (status: number): IvantiApiError =>
  new IvantiApiError({
    status,
    method: 'GET',
    url: "https://t/HEAT/api/odata/businessobject/Incidents?$filter=Customer eq 'Jane Doe'",
    body: 'echo of what was sent: Jane Doe',
  });

describe('runTool', () => {
  it.each([400, 403, 404])(
    'keeps an Ivanti %i at debug: the model is told, and it is not the operator\'s problem',
    async (status) => {
      const { logger, lines } = recorder();

      const result = await runTool('list_records', logger, () => Promise.reject(failWith(status)));

      expect(result.isError).toBe(true);
      expect(lines).toEqual([
        { level: 'debug', message: 'ivanti refused the request', fields: { tool: 'list_records', status } },
      ]);
    },
  );

  it.each([0, 401, 500, 503])('warns on an Ivanti %i, which nothing the model sends can fix', async (status) => {
    const { logger, lines } = recorder();

    await runTool('list_records', logger, () => Promise.reject(failWith(status)));

    expect(lines).toEqual([
      {
        level: 'warn',
        message: 'ivanti unavailable',
        fields: {
          tool: 'list_records',
          status,
          method: 'GET',
          path: '/HEAT/api/odata/businessobject/Incidents',
        },
      },
    ]);
    // Neither the query nor the echoed body belongs above debug.
    expect(JSON.stringify(lines)).not.toContain('Jane Doe');
  });

  it('logs an unexpected failure whole, so the stack is there to read', async () => {
    const { logger, lines } = recorder();
    const bug = new TypeError("Cannot read properties of undefined (reading 'RecId')");

    const result = await runTool('get_record', logger, () => Promise.reject(bug));

    expect(lines).toEqual([
      { level: 'error', message: 'tool failed', fields: { tool: 'get_record', error: bug } },
    ]);
    // What the model reads is unchanged.
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: bug.message }],
    });
  });
});
