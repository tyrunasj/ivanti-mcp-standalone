import type { IvantiTransport } from '../http/transport.js';
import { IvantiApiError } from '../http/errors.js';
import type { OdataRecord } from '../odata/response.js';
import { tenantCategorySpelling } from '../parent-link.js';

/**
 * Uploading a file, which Ivanti does in two halves and tells you about neither.
 *
 * `POST /api/rest/Attachment` stores the bytes and answers with the new attachment's RecId — and
 * leaves `ParentLink_RecID` and `ParentLink_Category` **null**. The file exists, belongs to
 * nothing, and is reachable only by searching the attachment table for its name. Linking it is a
 * second request. Measured live 2026-09-12, and the same behaviour overlord recorded in May.
 *
 * Worse, the upload does not care whether the parent exists: posting against a RecId of all
 * zeroes answered 200 and created an attachment. So the parent is read **before** any bytes are
 * sent — after them it is too late, and the caller is left with an orphan they were never told
 * about.
 */

/** `[{ FileName, IsUploaded, Message: '<32-hex RecId>' }]` — the RecId travels in `Message`. */
interface UploadReply {
  FileName?: unknown;
  IsUploaded?: unknown;
  Message?: unknown;
}

const REC_ID = /^[0-9A-F]{32}$/i;

export interface UploadedAttachment {
  attachmentId: string;
  filename: string;
  sizeBytes: number;
}

export interface AttachmentUploadRequest {
  transport: IvantiTransport;
  /** The parent's entity set, for the existence check. */
  parentEntitySet: string;
  /** The AdminUI form Ivanti wants here: `Incident#`. */
  parentObjectType: string;
  parentRecId: string;
  /** The object name, as CSDL spells it. The tenant's own casing is looked up from its rows. */
  parentCategory: string;
  filename: string;
  bytes: Uint8Array;
  contentType: string;
}

function readAttachmentId(reply: unknown): string | undefined {
  const first = Array.isArray(reply) ? (reply[0] as UploadReply | undefined) : undefined;
  const message = first?.Message;
  return typeof message === 'string' && REC_ID.test(message) ? message : undefined;
}

/**
 * The parent is not there, checked before any bytes were sent.
 *
 * Its own class rather than an `IvantiApiError`: nothing was refused by Ivanti — this layer
 * declined to send — and reporting it as an Ivanti status would hide the explanation behind
 * "Ivanti refused the request (400)".
 */
export class ParentNotFoundError extends Error {
  constructor(entitySet: string, recId: string) {
    super(
      `No ${entitySet} record with RecId ${recId} — nothing was uploaded. An upload against a ` +
        'parent that does not exist still succeeds in Ivanti and leaves a file attached to ' +
        'nothing, reachable only by searching the attachment table, so this is checked first.',
    );
    this.name = 'ParentNotFoundError';
  }
}

/**
 * The attachment exists but points at nothing, and only the caller can decide what to do about
 * it. Carries the id so it can be deleted rather than left to be found by accident.
 */
/**
 * The tenant does not accept this file *extension* — nothing to do with the bytes.
 *
 * Ivanti keeps a per-tenant allowlist and decides from the filename, so the same content uploads
 * as `.txt` and is refused as `.log`. It answers 200 with `IsUploaded: false`, so this is not an
 * error status at all and reads as success to anything checking the code.
 */
export class AttachmentTypeRefusedError extends Error {
  constructor(filename: string, because: string) {
    super(
      `Ivanti refused '${filename}': ${because}. This tenant allows only certain file ` +
        'extensions and decides from the NAME, not the contents — the same file is commonly ' +
        'accepted as .txt and refused as .log. Rename it to a permitted extension and upload ' +
        'again; retrying under the same name will fail identically.',
    );
    this.name = 'AttachmentTypeRefusedError';
  }
}

export class OrphanedAttachmentError extends Error {
  readonly attachmentId: string;

  constructor(attachmentId: string, filename: string, cause: string) {
    super(
      `'${filename}' was uploaded to Ivanti but could not be attached to the record: ${cause}. ` +
        'The file now exists on no record. Delete it with delete_attachment, or attach it ' +
        `again — its id is ${attachmentId}.`,
    );
    this.name = 'OrphanedAttachmentError';
    this.attachmentId = attachmentId;
  }
}

export async function uploadAttachment(
  request: AttachmentUploadRequest,
): Promise<UploadedAttachment> {
  const { transport, parentEntitySet, parentRecId, filename, bytes } = request;

  // Before the bytes, never after: Ivanti accepts an upload against a parent that does not
  // exist (verified with a RecId of all zeroes), and the resulting orphan is invisible from
  // every record.
  const missingParent = (): never => {
    throw new ParentNotFoundError(parentEntitySet, parentRecId);
  };

  // Both of Ivanti's ways of saying "not there": a 400 ISM_4000 "Invalid key", and a 200 with an
  // empty body. Only catching the rejection would let the second one through.
  const parent = await transport
    .request<OdataRecord>(transport.routes.record(parentEntitySet, parentRecId))
    .catch(missingParent);
  if (parent === undefined) missingParent();

  const form = new FormData();
  form.append('businessObjectId', parentRecId);
  form.append('objectType', request.parentObjectType);
  form.append('file', new Blob([bytes], { type: request.contentType }), filename);

  const reply = await transport.requestMultipart<UploadReply[]>(
    transport.routes.rest('Attachment'),
    form,
  );

  // Ivanti refuses by FILE EXTENSION, per tenant, and answers 200 with `IsUploaded: false` —
  // measured: identical bytes accepted as `.txt` and refused as `.log`. The raw reply says only
  // "Invalid attachment type", which a caller cannot act on without knowing the cause is the name.
  const refusal = Array.isArray(reply) ? reply[0] : undefined;
  if (refusal?.IsUploaded === false) {
    const because = typeof refusal.Message === 'string' ? refusal.Message : 'no reason given';
    throw new AttachmentTypeRefusedError(filename, because);
  }

  const attachmentId = readAttachmentId(reply);
  if (attachmentId === undefined) {
    throw new IvantiApiError(
      { status: 200, method: 'POST', url: 'Attachment', body: JSON.stringify(reply) },
      `Ivanti accepted '${filename}' but did not answer with an attachment id, so there is no ` +
        'way to tell what was stored or to attach it. Check the record before retrying — a ' +
        'retry may leave two copies.',
    );
  }

  // The half Ivanti does not do. Without it the file is uploaded and unreachable.
  const category = await tenantCategorySpelling(transport, 'attachments', request.parentCategory);
  try {
    await transport.request(transport.routes.record('attachments', attachmentId), {
      method: 'PATCH',
      body: { ParentLink_RecID: parentRecId, ParentLink_Category: category },
    });
  } catch (error: unknown) {
    // try/catch rather than `.catch`: this has to hold whether the transport rejects or throws
    // on the way in, and the difference is invisible from here.
    throw new OrphanedAttachmentError(
      attachmentId,
      filename,
      error instanceof Error ? error.message : 'unknown error',
    );
  }

  return { attachmentId, filename, sizeBytes: bytes.byteLength };
}
