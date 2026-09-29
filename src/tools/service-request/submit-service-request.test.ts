// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import type { CallContext } from '../tool-definition.js';
import { createSubmitServiceRequestTool } from './submit-service-request.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const body = (result: CallToolResult): Record<string, unknown> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, unknown>;
};

function pinned(): CallContext {
  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
  context.pin?.pin({
    recId: 'E1',
    category: 'employee',
    displayName: 'Paul H Chang',
    matchedOn: 'LoginID',
    provenance: 'asserted',
  });
  return context;
}

const CREATED = {
  IsSuccess: true,
  ErrorText: '',
  ServiceRequests: [
    {
      strRequestRecId: 'sr1',
      strRequestNum: '10219',
      strName: 'New Laptop',
      parameterTemplateParameterIds: { P1: 'i1' },
    },
  ],
};

/**
 * A request filed with one file, through the form submit that binds staged files.
 *
 * `responses` is matched in declaration order, and the parameter relationship's URL contains the
 * request's own — so it is declared first.
 */
function filing(responses: Record<string, unknown>) {
  const { connection, urls } = connectionFixture({
    entities: { servicereq: {}, employee: {} },
    responses: {
      ServiceReqContainsServiceReqParam: {
        value: [{ ParameterName: 'Notes', ParameterValue: 'x', SvcReqTmplParamLink_RecID: 'P1' }],
      },
      "servicereqs('sr1')": { RecId: 'sr1', Subject: 'New Laptop', ProfileFullName: 'Paul H Chang' },
      ...responses,
    },
    sessionCalls: { GetUploadTicket: 'ticket-1', SubmitRequestForUser: CREATED },
  });
  vi.spyOn(connection.session, 'uploadToHandler').mockResolvedValue(
    '{ attachmentIds:[ { filename:"quote.txt" ,attachmentId:"CE16" } ] ,attachmentId:"CE16" }',
  );
  return {
    urls,
    submit: createSubmitServiceRequestTool({
      connection,
      gate: OPEN_GATE,
      logger: logger(),
      ownRecordsOnly: false,
      actions: OPEN_ACTIONS,
    }),
  };
}

const WITH_FILE = {
  subscriptionId: 'sub-1',
  answers: { P1: 'x' },
  attachments: [{ filename: 'quote.txt', contentBase64: Buffer.from('quote').toString('base64') }],
};

describe('submit_service_request, with files', () => {
  it('reports the files the request carries, read back — not the ones staged for it', async () => {
    // `attached` used to echo the staged list, so a file the submit did not bind was still
    // reported as on the request.
    const { submit, urls } = filing({
      attachments: { value: [{ ATTACHNAME: 'quote.txt' }, { ATTACHNAME: 'template-guide.pdf' }] },
    });

    const result = body(await submit.handler(WITH_FILE, pinned()));

    expect(result['attached']).toEqual(['quote.txt', 'template-guide.pdf']);
    expect(result).not.toHaveProperty('notAttached');
    expect(urls.some((url) => url.includes("attachments?$filter=ParentLink_RecID%20eq%20'sr1'"))).toBe(
      true,
    );
  });

  it('names a staged file that is not on the request, and how to add it', async () => {
    const { submit } = filing({ attachments: { value: [] } });

    const result = body(await submit.handler(WITH_FILE, pinned()));

    expect(result['attached']).toEqual([]);
    expect(result['notAttached']).toEqual(['quote.txt']);
    expect(String(result['attachmentWarning'])).toContain('upload_attachment');
  });

  it('says the files are unconfirmed when their read-back fails', async () => {
    const { submit } = filing({ 'attachments?': new Error('Ivanti 500') });

    const result = body(await submit.handler(WITH_FILE, pinned()));

    expect(result['attached']).toBe('unknown');
    expect(String(result['attachmentWarning'])).toContain('NOT confirmed');
    // The request was still filed, and its number still reported.
    expect(result['requestNumber']).toBe('10219');
  });

  it('says when the subject passed is not the one the request carries', async () => {
    const { submit } = filing({ attachments: { value: [{ ATTACHNAME: 'quote.txt' }] } });

    const result = body(
      await submit.handler({ ...WITH_FILE, subject: 'Laptop for Jo' }, pinned()),
    );

    expect(result['subject']).toBe('New Laptop');
    expect(String(result['subjectNote'])).toContain('not applied');
  });

  it('reports a subject that did land without a note', async () => {
    const { submit } = filing({
      "servicereqs('sr1')": { RecId: 'sr1', Subject: 'Laptop for Jo' },
      attachments: { value: [{ ATTACHNAME: 'quote.txt' }] },
    });

    const result = body(
      await submit.handler({ ...WITH_FILE, subject: 'Laptop for Jo' }, pinned()),
    );

    expect(result['subject']).toBe('Laptop for Jo');
    expect(result).not.toHaveProperty('subjectNote');
  });

  it('points at the files path when a date lands wrong on it', async () => {
    const { submit } = filing({
      ServiceReqContainsServiceReqParam: {
        value: [
          {
            ParameterName: 'StartDate',
            ParameterValue: '2026-09-28T22:00:00Z',
            SvcReqTmplParamLink_RecID: 'P1',
          },
        ],
      },
      attachments: { value: [{ ATTACHNAME: 'quote.txt' }] },
    });

    const result = body(
      await submit.handler(
        { ...WITH_FILE, answers: { P1: '2026-09-30' }, localOffsetMinutes: -120 },
        pinned(),
      ),
    );

    expect(result['answersVerified']).toBe(false);
    expect(String(result['dateNote'])).toContain('form submit');
  });
});
