// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../connection.fixture.js';
import { IvantiApiError } from '../http/errors.js';
import {
  AttachmentLinkUnconfirmedError,
  AttachmentTypeRefusedError,
  OrphanedAttachmentError,
  linkCategory,
  uploadAttachment,
} from './upload.js';

const REC_ID = 'A'.repeat(32);
const BYTES = new TextEncoder().encode('hello');

function setup(responses: Record<string, unknown>) {
  const { connection, urls } = connectionFixture({ entities: { incident: {} }, responses });
  const request = vi.spyOn(connection.transport, 'request');
  return {
    urls,
    /** The body each PATCH carried — the fixture records URLs only. */
    patches: (): Record<string, unknown>[] =>
      request.mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([, init]) => (init?.body ?? {}) as Record<string, unknown>),
    upload: (author?: string) =>
      uploadAttachment({
        transport: connection.transport,
        parentEntitySet: 'incidents',
        parentObjectType: 'incident#',
        parentRecId: 'i1',
        parentCategory: 'incident',
        filename: 'note.txt',
        bytes: BYTES,
        contentType: 'text/plain',
        ...(author === undefined ? {} : { author }),
      }),
  };
}

const UPLOADED = { 'POST Attachment': [{ FileName: 'note.txt', IsUploaded: true, Message: REC_ID }] };

/** The attachment row as the read-back finds it. It also serves the category-spelling sample. */
const ROW = (over: Record<string, unknown> = {}) => ({
  attachments: {
    value: [
      {
        RecId: REC_ID,
        ATTACHNAME: 'note.txt',
        AttachmentSize: 5,
        ParentLink_RecID: 'i1',
        ParentLink_Category: 'Incident',
        CreatedBy: 'HSanders',
        LastModBy: 'HSanders',
        ...over,
      },
    ],
  },
});

const LINKED = {
  "incidents('i1')": { RecId: 'i1' },
  ...UPLOADED,
  'PATCH attachments': { code: 'ISM_2000' },
};

describe('uploadAttachment', () => {
  it('uploads, then links, because Ivanti only does the first half', async () => {
    const { upload, urls } = setup({ ...LINKED, ...ROW() });

    const result = await upload();

    expect(result).toMatchObject({ attachmentId: REC_ID, filename: 'note.txt', sizeBytes: 5 });
    // The PATCH is the half that makes the file reachable from the record.
    expect(urls.some((url) => url.startsWith('PATCH') && url.includes('attachments'))).toBe(true);
  });

  it('reads the attachment back after linking, and reports what is stored', async () => {
    // The description promised a verified link; nothing read the row after the PATCH, so a
    // link Ivanti accepted and ignored was reported as attached.
    const { upload, urls } = setup({ ...LINKED, ...ROW() });

    const result = await upload();

    const patch = urls.findIndex((url) => url.startsWith('PATCH'));
    expect(urls.slice(patch + 1).some((url) => url.includes(`RecId%20eq%20'${REC_ID}'`))).toBe(
      true,
    );
    expect(result.stored).toEqual({
      parentRecId: 'i1',
      parentCategory: 'Incident',
      name: 'note.txt',
      sizeBytes: 5,
      createdBy: 'HSanders',
      lastModBy: 'HSanders',
    });
  });

  it('reports an orphan when Ivanti accepts the link but the row is on no record', async () => {
    const { upload } = setup({
      ...LINKED,
      ...ROW({ ParentLink_RecID: null, ParentLink_Category: null }),
    });

    await expect(upload()).rejects.toThrow(OrphanedAttachmentError);
    await expect(upload()).rejects.toThrow(/shows it on no record/);
  });

  it('writes the link as the AdminUI id, in the tenant’s casing', async () => {
    // docs/notes.md, measured 2026-09-12: the PATCH is refused with `Incident` and succeeds with
    // `Incident#` — and only then does `CreatedBy` stick. This used to write the rows' spelling.
    const { upload, patches, urls } = setup({ ...LINKED, ...ROW() });

    await upload('HSanders');

    expect(patches()).toEqual([
      { ParentLink_RecID: 'i1', ParentLink_Category: 'Incident#', CreatedBy: 'HSanders' },
    ]);
    // The casing still comes from the rows: CSDL says `incident`, the measured value did not.
    expect(urls.some((url) => url.includes("ParentLink_Category%20eq%20'incident'"))).toBe(true);
  });

  it('checks the parent BEFORE sending the bytes', async () => {
    // Ivanti accepts an upload against a RecId of all zeroes and creates a file attached to
    // nothing, so afterwards is too late to find out.
    const { upload, urls } = setup({ ...UPLOADED });

    await expect(upload()).rejects.toThrow(/No incidents record with RecId i1/);
    expect(urls.filter((url) => url.includes('rest/Attachment'))).toEqual([]);
  });

  it('reports an orphan rather than a success when the link fails and the row agrees', async () => {
    const { upload } = setup({
      "incidents('i1')": { RecId: 'i1' },
      ...UPLOADED,
      ...ROW({ ParentLink_RecID: null, ParentLink_Category: null }),
      'PATCH attachments': new Error('locked'),
    });

    // The file exists and is on no record; the caller needs the id to clean it up.
    await expect(upload()).rejects.toThrow(OrphanedAttachmentError);
    await expect(upload()).rejects.toThrow(new RegExp(REC_ID));
    await expect(upload()).rejects.toThrow(/locked/);
  });

  it('checks whether a timed-out link landed before calling the file an orphan', async () => {
    // A timeout says nothing about whether Ivanti applied the PATCH. Declaring an orphan here
    // sent a caller to delete a file that was on the ticket all along.
    const { upload } = setup({
      "incidents('i1')": { RecId: 'i1' },
      ...UPLOADED,
      ...ROW(),
      'PATCH attachments': new IvantiApiError(
        { status: 0, method: 'PATCH', url: 'attachments', body: 'The operation was aborted due to timeout' },
        'Ivanti PATCH timed out',
      ),
    });

    const result = await upload();

    expect(result.stored.parentRecId).toBe('i1');
    expect(result.linkReplyLost).toContain('timed out');
  });

  it('says it cannot tell when the read-back fails, rather than guessing either way', async () => {
    const { upload } = setup({ ...LINKED, 'attachments?': new Error('Ivanti 500') });

    await expect(upload()).rejects.toThrow(AttachmentLinkUnconfirmedError);
    await expect(upload()).rejects.toThrow(/NOT KNOWN/);
  });

  it('says it cannot tell when the read-back finds no such file', async () => {
    const { upload } = setup({ ...LINKED, attachments: { value: [] } });

    await expect(upload()).rejects.toThrow(AttachmentLinkUnconfirmedError);
    await expect(upload()).rejects.toThrow(/found no such file/);
  });

  it('explains a refused file EXTENSION, which arrives as a 300 rather than a failure', async () => {
    // Measured live: `.log` answers 300 Multiple Choices with the outcome in the body, while the
    // same bytes as `.txt` answer 200. The transport throws on any non-2xx, so without unpacking
    // the rejection the caller saw a bare `Ivanti POST 300` and no reason.
    const { upload } = setup({
      "incidents('i1')": { RecId: 'i1' },
      'POST Attachment': new IvantiApiError({
        status: 300,
        method: 'POST',
        url: 'Attachment',
        body: JSON.stringify([
          { FileName: 'note.log', IsUploaded: false, Message: 'Upload Failed, Invalid attachment type.' },
        ]),
      }),
    });

    await expect(upload()).rejects.toThrow(AttachmentTypeRefusedError);
    await expect(upload()).rejects.toThrow(/judges by the NAME/);
  });

  it('re-throws any other upload failure untouched', async () => {
    const { upload } = setup({
      "incidents('i1')": { RecId: 'i1' },
      'POST Attachment': new IvantiApiError({ status: 500, method: 'POST', url: 'Attachment' }),
    });

    await expect(upload()).rejects.toThrow(IvantiApiError);
  });

  it('refuses when Ivanti answers without an attachment id', async () => {
    const { upload } = setup({
      "incidents('i1')": { RecId: 'i1' },
      'POST Attachment': [{ FileName: 'note.txt', IsUploaded: true, Message: 'not-a-recid' }],
    });

    await expect(upload()).rejects.toThrow(/did not answer with an attachment id/);
  });
});

describe('linkCategory', () => {
  it('appends the `#` to the tenant’s own spelling of the object', () => {
    expect(linkCategory('incident#', 'Incident')).toBe('Incident#');
    expect(linkCategory('servicereq#', 'ServiceReq')).toBe('ServiceReq#');
  });

  it('keeps the AdminUI id when the rows spell the object some other way', () => {
    // A derived object's rows need not match its CSDL name; the id the upload used is the one
    // Ivanti already accepted for this file.
    expect(linkCategory('ci#computer', 'ci__computer')).toBe('ci#computer');
  });
});
