// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import type { CallContext } from '../tool-definition.js';
import { createUploadAttachmentTool } from './upload-attachment.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};
const body = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(text(result) || '{}') as Record<string, unknown>;

const PERSON = {
  recId: 'E1',
  category: 'employee',
  displayName: 'Harold Sanders',
  loginId: 'HSanders',
  matchedOn: 'LoginID',
  provenance: 'asserted',
} as const;

function pinned(): CallContext {
  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
  context.pin?.pin({ ...PERSON });
  return context;
}

const REC_ID = 'A'.repeat(32);
const ARGS = {
  object: 'Incidents',
  recordId: 'i1',
  filename: 'note.txt',
  contentBase64: Buffer.from('hello').toString('base64'),
};

const TENANT = {
  "incidents('i1')": { RecId: 'i1', ProfileLink_RecID: 'E1', ReadOnly: false },
  'POST Attachment': [{ FileName: 'note.txt', IsUploaded: true, Message: REC_ID }],
  'PATCH attachments': { code: 'ISM_2000' },
};

const row = (over: Record<string, unknown> = {}) => ({
  attachments: {
    value: [
      {
        RecId: REC_ID,
        ATTACHNAME: 'note.txt',
        AttachmentSize: 5,
        ParentLink_RecID: 'i1',
        ParentLink_Category: 'Incident',
        ...over,
      },
    ],
  },
});

function tool(responses: Record<string, unknown>, ownRecordsOnly = false) {
  const { connection } = connectionFixture({
    entities: {
      incident: {
        fields: [field('RecId'), field('ProfileLink_RecID'), field('ProfileLink_Category')],
      },
      employee: {},
    },
    responses,
  });
  const errors = vi.fn();
  return {
    errors,
    upload: createUploadAttachmentTool({
      connection,
      gate: OPEN_GATE,
      logger: { ...logger(), error: errors },
      ownRecordsOnly,
      actions: OPEN_ACTIONS,
    }),
  };
}

describe('upload_attachment', () => {
  it('reports who Ivanti recorded, read off the row rather than asserted', async () => {
    // `lastModBy` was hard-coded to the service account, which is false under an impersonated
    // session: the write then runs as the person, and Ivanti records them.
    const { upload } = tool({ ...TENANT, ...row({ CreatedBy: 'HSanders', LastModBy: 'HSanders' }) });

    const result = body(await upload.handler(ARGS, pinned()));

    expect(result).toMatchObject({
      attachmentId: REC_ID,
      attached: true,
      createdBy: 'HSanders',
      lastModBy: 'HSanders',
    });
    expect(JSON.stringify(result)).not.toContain('service account');
  });

  it('drops an attribution the row does not carry instead of guessing it', async () => {
    const { upload } = tool({ ...TENANT, ...row() });

    const result = body(await upload.handler(ARGS, pinned()));

    expect(result['attached']).toBe(true);
    expect(result).not.toHaveProperty('lastModBy');
    expect(result).not.toHaveProperty('createdBy');
  });

  it('says a lost link reply did no harm when the read-back finds the file attached', async () => {
    const { upload } = tool({
      ...TENANT,
      ...row(),
      'PATCH attachments': new Error('Ivanti PATCH timed out'),
    });

    const result = body(await upload.handler(ARGS, pinned()));

    expect(result['attached']).toBe(true);
    expect(String(result['linkNote'])).toContain('Do not upload it again');
  });

  it('points a full-mode caller at delete_attachment for an orphan', async () => {
    const { upload, errors } = tool({ ...TENANT, ...row({ ParentLink_RecID: null }) });

    const result = await upload.handler(ARGS, pinned());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('delete_attachment');
    expect(text(result)).toContain(REC_ID);
    expect(errors).toHaveBeenCalled();
  });

  it('does not send an end user to a delete that refuses files on no record', async () => {
    // delete_attachment refuses, in enduser, an attachment that names no record — so the old
    // advice led straight into a refusal, with a file the person could neither reach nor remove.
    const { upload } = tool({ ...TENANT, ...row({ ParentLink_RecID: null }) }, true);

    const result = await upload.handler(ARGS, pinned());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('cannot be removed from here');
    expect(text(result)).not.toMatch(/Delete it with delete_attachment/);
  });

  it('says whether an unconfirmed link can be checked, in the words the mode allows', async () => {
    const { upload } = tool({ ...TENANT, 'attachments?': new Error('Ivanti 500') }, true);

    const result = await upload.handler(ARGS, pinned());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('NOT KNOWN');
    expect(text(result)).toContain('get_attachment_details');
    expect(text(result)).not.toContain('delete it with delete_attachment');
  });
});
