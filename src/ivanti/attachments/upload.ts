// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

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
  /**
   * The login of the person this file is being attached FOR, when one is known.
   *
   * Without it every attachment is stamped with this server's service account, so a file an end
   * user sent in reads as having been added by the service desk. `CreatedBy` is one of the audit
   * fields Ivanti lets a caller override, and it is honoured here: measured on the live tenant,
   * a PATCH setting it alongside the parent link answered 200 and the value stuck.
   *
   * `LastModBy` is deliberately not attempted — Ivanti accepts it and stores the session account
   * regardless, which would report an attribution that did not happen.
   */
  author?: string | undefined;
}

/**
 * The upload reply, recovered from a rejection.
 *
 * A refused extension comes back as **300 Multiple Choices**, so `fetch` reports `ok: false` and
 * the transport throws before anything reads the body — which meant the whole
 * `AttachmentTypeRefusedError` path below was unreachable, and a caller who uploaded a `.log` got
 * a bare `Ivanti POST 300` with no explanation. Measured live: `.log` → 300 with
 * `IsUploaded: false`, the same bytes as `.txt` → 200.
 *
 * Narrow on purpose: only 300, only a JSON array. Any other failure is re-thrown untouched.
 */
function refusedUpload(error: unknown): UploadReply[] | undefined {
  if (!(error instanceof IvantiApiError) || error.status !== 300) return undefined;
  try {
    const parsed: unknown = JSON.parse(error.body);
    return Array.isArray(parsed) ? (parsed as UploadReply[]) : undefined;
  } catch {
    return undefined;
  }
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
 * as `.txt` and is refused as `.log`. It answers **300 Multiple Choices** — not a 2xx, not a 4xx —
 * with the per-file outcome in the body, which is why `refusedUpload` below has to dig the reply
 * back out of a rejection instead of reading it from a success.
 */
export class AttachmentTypeRefusedError extends Error {
  constructor(filename: string, because: string) {
    super(
      `Ivanti refused '${filename}': ${because}. This tenant allowlists file extensions and ` +
        'judges by the NAME, never the contents. RENAME IT `.txt` AND UPLOAD AGAIN — that is ' +
        'accepted on every tenant measured, and the identical bytes go through. Retrying under ' +
        'the same name will fail identically. The allowlist is per tenant and is not readable ' +
        'through the API, so there is no way to list what it permits; `.log`, `.json`, `.md` ' +
        'and `.yaml` are commonly refused even though they are plain text.',
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

  const reply = await transport
    .requestMultipart<UploadReply[]>(transport.routes.rest('Attachment'), form)
    .catch((error: unknown) => {
      const refused = refusedUpload(error);
      if (refused === undefined) throw error;
      return refused;
    });

  // Ivanti refuses by FILE EXTENSION, per tenant — measured: identical bytes accepted as `.txt`
  // and refused as `.log`. The raw reply says only "Invalid attachment type", which a caller
  // cannot act on without knowing the cause is the name.
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
      body: {
        ParentLink_RecID: parentRecId,
        ParentLink_Category: category,
        // Same PATCH, because a second one would be a second chance to fail and leave the file
        // linked but misattributed.
        ...(request.author === undefined || request.author === ''
          ? {}
          : { CreatedBy: request.author }),
      },
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
