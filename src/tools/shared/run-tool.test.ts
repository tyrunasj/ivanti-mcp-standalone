// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import type { Logger, LogLevel } from '../../logger.js';
import { IvantiApiError, ResponseTooLargeError } from '../../ivanti/http/errors.js';
import { type CallUsage, withCallUsage } from '../../usage/call-usage.js';
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
  it.each([
    ['person', 401, true],
    ['service', 401, undefined],
    [undefined, 401, undefined],
    ['person', 500, undefined],
  ] as const)(
    'flags the person\'s session as refused only for a 401 on their credential (%s, %i)',
    async (credential, status, flagged) => {
      const { logger } = recorder();
      const usage: CallUsage = { ivantiRequests: 0 };
      const failure = new IvantiApiError({
        status,
        method: 'GET',
        url: 'https://t/HEAT/api/odata/x',
        ...(credential === undefined ? {} : { credential }),
      });

      await withCallUsage(usage, () => runTool('list_records', logger, () => Promise.reject(failure)));

      expect(usage.personRefused).toBe(flagged);
      expect(usage.outcome).toBe(`ivanti ${String(status)}`);
    },
  );

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

  it('puts the network code on the warn line, which is what tells a DNS typo from a proxy', async () => {
    const { logger, lines } = recorder();
    const unreachable = new IvantiApiError({
      status: 0,
      method: 'GET',
      url: 'https://t/HEAT/api/odata/businessobject/Incidents',
      body: 'fetch failed: getaddrinfo ENOTFOUND t',
      code: 'ENOTFOUND',
    });

    await runTool('list_records', logger, () => Promise.reject(unreachable));

    expect(lines[0]).toMatchObject({ level: 'warn', fields: { code: 'ENOTFOUND' } });
  });

  /**
   * A timed-out create was told to the model as "Ivanti refused the request (0)". It retried, and
   * the ticket was filed twice. Nothing came back is not the same as no — and for a write it means
   * the change may well have been made.
   */
  describe('when nothing came back', () => {
    const unanswered = (status: number, method: string): IvantiApiError =>
      new IvantiApiError({
        status,
        method,
        url: 'https://t/HEAT/api/odata/businessobject/Incidents',
        body: status === 0 ? 'no answer within 30000 ms' : '<html>Gateway Timeout</html>',
      });

    const textOf = async (error: IvantiApiError): Promise<string> => {
      const result = await runTool('create_record', recorder().logger, () => Promise.reject(error));
      expect(result.isError).toBe(true);
      return (result.content[0] as { text: string }).text;
    };

    it.each([
      [0, 'POST'],
      [0, 'PATCH'],
      [0, 'DELETE'],
      [502, 'POST'],
      [504, 'POST'],
    ])('says a %i on a %s may have been applied, and to check before retrying', async (status, method) => {
      const text = await textOf(unanswered(status, method));

      expect(text).toMatch(/MAY HAVE TAKEN EFFECT/);
      expect(text).toMatch(/Before trying again, check/);
      expect(text).not.toMatch(/refused/i);
    });

    it('says why, when it knows', async () => {
      await expect(textOf(unanswered(0, 'POST'))).resolves.toContain('no answer within 30000 ms');
    });

    it.each([0, 502, 504])('tells a read that got a %i it was not refused, and not to rephrase', async (status) => {
      const text = await textOf(unanswered(status, 'GET'));

      expect(text).toMatch(/not a refusal/);
      expect(text).not.toMatch(/MAY HAVE TAKEN EFFECT/);
    });

    it('leaves an answer that was a refusal worded as one', async () => {
      await expect(textOf(unanswered(500, 'POST'))).resolves.toMatch(/refused the request \(500\)/);
    });
  });

  // Quick actions are not registered in enduser without an allowlist, nor on the odata tier.
  it('does not send a gated transition to a tool that may not exist', async () => {
    const prompt = new IvantiApiError({
      status: 400,
      method: 'PATCH',
      url: 'https://t/HEAT/api/odata/businessobject/Incidents',
      body: '{"code":"ISM_4000","description":"DataLayer.PromptException"}',
    });

    const result = await runTool('update_record', recorder().logger, () => Promise.reject(prompt));

    expect((result.content[0] as { text: string }).text).not.toMatch(/list_quick_actions/);
  });

  it('refuses a file too large to read in its own words, and not as a fault', async () => {
    const { logger, lines } = recorder();

    const result = await runTool('download_attachment', logger, () =>
      Promise.reject(new ResponseTooLargeError('https://t/x', 1024, 4096)),
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/not downloaded/);
    expect(text).not.toMatch(/refused the request/);
    // A file the person has is not a bug in this server.
    expect(lines.map((line) => line.level)).toEqual(['debug']);
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
