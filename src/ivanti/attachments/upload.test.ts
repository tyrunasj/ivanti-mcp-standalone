import { describe, expect, it } from 'vitest';
import { connectionFixture } from '../connection.fixture.js';
import { OrphanedAttachmentError, uploadAttachment } from './upload.js';

const REC_ID = 'A'.repeat(32);
const BYTES = new TextEncoder().encode('hello');

function setup(responses: Record<string, unknown>) {
  const { connection, urls } = connectionFixture({ entities: { incident: {} }, responses });
  return {
    urls,
    upload: () =>
      uploadAttachment({
        transport: connection.transport,
        parentEntitySet: 'incidents',
        parentObjectType: 'Incident#',
        parentRecId: 'i1',
        parentCategory: 'incident',
        filename: 'note.txt',
        bytes: BYTES,
        contentType: 'text/plain',
      }),
  };
}

const UPLOADED = { 'POST Attachment': [{ FileName: 'note.txt', IsUploaded: true, Message: REC_ID }] };

describe('uploadAttachment', () => {
  it('uploads, then links, because Ivanti only does the first half', async () => {
    const { upload, urls } = setup({
      "incidents('i1')": { RecId: 'i1' },
      ...UPLOADED,
      'PATCH attachments': { code: 'ISM_2000' },
      attachments: { value: [{ ParentLink_Category: 'Incident' }] },
    });

    const result = await upload();

    expect(result).toEqual({ attachmentId: REC_ID, filename: 'note.txt', sizeBytes: 5 });
    // The PATCH is the half that makes the file reachable from the record.
    expect(urls.some((url) => url.startsWith('PATCH') && url.includes('attachments'))).toBe(true);
  });

  it('checks the parent BEFORE sending the bytes', async () => {
    // Ivanti accepts an upload against a RecId of all zeroes and creates a file attached to
    // nothing, so afterwards is too late to find out.
    const { upload, urls } = setup({ ...UPLOADED });

    await expect(upload()).rejects.toThrow(/No incidents record with RecId i1/);
    expect(urls.filter((url) => url.includes('rest/Attachment'))).toEqual([]);
  });

  it('copies the tenant’s own spelling of the category', async () => {
    // CSDL says `incident`; the tenant's rows say `Incident`, and a column with both in it is
    // how a customer's reports start counting one file separately.
    const { upload, urls } = setup({
      "incidents('i1')": { RecId: 'i1' },
      ...UPLOADED,
      'PATCH attachments': { code: 'ISM_2000' },
      attachments: { value: [{ ParentLink_Category: 'Incident' }] },
    });

    await upload();

    expect(urls.some((url) => url.includes("ParentLink_Category%20eq%20'incident'"))).toBe(true);
  });

  it('reports an orphan rather than a success when the link fails', async () => {
    const { upload } = setup({
      "incidents('i1')": { RecId: 'i1' },
      ...UPLOADED,
      attachments: { value: [] },
      'PATCH attachments': new Error('locked'),
    });

    // The file exists and is on no record; the caller needs the id to clean it up.
    await expect(upload()).rejects.toThrow(OrphanedAttachmentError);
    await expect(upload()).rejects.toThrow(new RegExp(REC_ID));
  });

  it('refuses when Ivanti answers without an attachment id', async () => {
    const { upload } = setup({
      "incidents('i1')": { RecId: 'i1' },
      'POST Attachment': [{ FileName: 'note.txt', IsUploaded: true, Message: 'not-a-recid' }],
    });

    await expect(upload()).rejects.toThrow(/did not answer with an attachment id/);
  });
});
