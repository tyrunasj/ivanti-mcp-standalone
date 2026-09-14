// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import type { IvantiSession } from '../session/asmx-session.js';
import {
  describeFailure,
  executeAction,
  listQuickActions,
  toActionObjectId,
} from './execute.js';

const session = (answer: unknown): { session: IvantiSession; calls: { method: string; args: Record<string, unknown> }[] } => {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    session: {
      identity: () => Promise.resolve({ role: 'Admin' }),
      identityIfKnown: () => ({ role: 'Admin' }),
      callHandler: () => Promise.reject(new Error('unused')),
      uploadToHandler: () => Promise.reject(new Error('no handler in this fixture')),
      call: (_service: string, method: string, args: Record<string, unknown> = {}) => {
        calls.push({ method, args });
        return Promise.resolve(answer) as Promise<never>;
      },
    },
  };
};

describe('toActionObjectId', () => {
  it('adds the # a quick action expects, and leaves a subtype alone', () => {
    expect(toActionObjectId('incident')).toBe('incident#');
    expect(toActionObjectId('CI#Computer')).toBe('CI#Computer');
  });
});

describe('listQuickActions', () => {
  it('decodes the rows, which arrive as columns', async () => {
    const { session: live } = session([
      ['id-1', 'Escalate', 'UpdateObject'],
      ['id-2', 'Send reminder', 'SendEmail'],
      ['', 'no id', 'UpdateObject'],
      'not a row',
    ]);

    await expect(listQuickActions(live, 'Incident#')).resolves.toEqual([
      { actionId: 'id-1', name: 'Escalate', actionType: 'UpdateObject' },
      { actionId: 'id-2', name: 'Send reminder', actionType: 'SendEmail' },
    ]);
  });

  it('is empty rather than throwing when Ivanti answers something else', async () => {
    const { session: live } = session({ unexpected: true });

    await expect(listQuickActions(live, 'Incident#')).resolves.toEqual([]);
  });
});

describe('executeAction', () => {
  it('always uses the FORM path, which is the only one that honours "do not save"', async () => {
    // GridParams ignores shouldSave:false and RUNS the action while reporting itself a probe.
    const { session: live, calls } = session({ status: 'ok' });

    await executeAction({
      session: live,
      objectId: 'Incident#',
      recordId: 'rec-1',
      actionId: 'act-1',
      formName: 'Incident.Header',
      shouldSave: false,
    });

    const args = calls[0]?.args as { shouldSave: boolean; actionParams: Record<string, unknown> };
    expect(args.shouldSave).toBe(false);
    expect(args.actionParams.GridParams).toBeNull();
    expect(JSON.stringify(args.actionParams.FormParams)).toContain('Incident.Header');
  });

  it('echoes the token from its own probe when committing', async () => {
    const { session: live, calls } = session({ status: 'ok' });

    await executeAction({
      session: live,
      objectId: 'Incident#',
      recordId: 'rec-1',
      actionId: 'act-1',
      formName: 'F',
      shouldSave: true,
      parentActionExecutionInstanceId: 'token-from-probe',
    });

    expect(calls[0]?.args.parentActionExecutionInstanceId).toBe('token-from-probe');
  });
});

describe('describeFailure', () => {
  it('flattens the per-field messages, which name what the status does not', () => {
    const lines = describeFailure({
      status: 'error',
      errors: {
        errorMessages: ['Action failed'],
        validationErrors: {
          'rec-1': {
            fieldErrors: {
              Category: { fieldMessages: ['Required field Incident.Category value must be provided'] },
            },
          },
        },
      },
    });

    expect(lines).toEqual([
      'Action failed',
      'Category: Required field Incident.Category value must be provided',
    ]);
  });

  it('is empty for a clean result', () => {
    expect(describeFailure({ status: 'ok', saved: true })).toEqual([]);
    expect(describeFailure({ errors: { warningMessages: ['just a warning'] } })).toEqual([]);
  });
});
