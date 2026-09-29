// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import {
  AttachmentLinkUnconfirmedError,
  OrphanedAttachmentError,
  uploadAttachment,
  type UploadedAttachment,
} from '../../ivanti/attachments/upload.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { assertRecordWritable } from '../shared/own-records.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { transportFor } from '../shared/transport-for.js';

/**
 * The ceiling on a file, and why there is one.
 *
 * Bytes reach this tool as base64 in a tool argument, which means they pass through the model's
 * context twice — once written, once echoed in the transcript — at 4 characters per 3 bytes. A
 * megabyte of file is ~1.4 MB of argument. There is no streaming alternative on an MCP tool call,
 * so the limit is the honest answer rather than a configurable one.
 */
const MAX_BYTES = 2 * 1024 * 1024;

/** Anything not obviously text, which is most of what gets attached. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * What to do about a file that is uploaded but not (or not provably) on the record.
 *
 * Mode decides it. `delete_attachment` refuses, in `enduser`, a file that names no record —
 * nothing then shows whose it is — so advising it there sent the person into a refusal with a
 * file they could neither reach nor remove.
 */
function remedy(
  error: OrphanedAttachmentError | AttachmentLinkUnconfirmedError,
  enduser: boolean,
): string {
  const id = error.attachmentId;
  if (error instanceof OrphanedAttachmentError) {
    return enduser
      ? 'It cannot be removed from here: delete_attachment refuses a file that is on no record, ' +
          'because nothing shows whose it is. Uploading again is how to get the file onto the ' +
          `ticket — tell the person a stray copy (id ${id}) was left behind for the service desk ` +
          'to remove.'
      : `Delete it with delete_attachment (id ${id}) before uploading again, or the retry leaves ` +
          'two copies.';
  }
  return enduser
    ? `Check with get_attachment_details (id ${id}) before uploading again: if it answers, the ` +
        'file is on the ticket; if it refuses because the file names no record, upload again and ' +
        'tell the person a stray copy was left for the service desk to remove.'
    : `Check with get_attachment_details (id ${id}) before uploading again: if it names this ` +
        'record the file is attached; if it names none, delete it with delete_attachment and ' +
        'upload again.';
}

export function createUploadAttachmentTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'upload_attachment',
    title: 'Upload attachment',
    description:
      'Attaches a file to an existing record.\n\n' +
      'THE FILE ARRIVES AS BASE64 IN THIS CALL, so it costs context twice over and is capped at ' +
      `${String(MAX_BYTES / 1024 / 1024)} MB. For anything larger, have the person attach it in ` +
      'Ivanti directly — that is faster for them than pasting it through a conversation.\n\n' +
      'Ivanti does this in two halves and only does one of them: the upload stores the bytes and ' +
      'leaves the file attached to NOTHING. This tool performs the second half and verifies it, ' +
      'so a file that ends up on no record is reported as a failure rather than as success.\n\n' +
      'The parent is checked BEFORE the bytes are sent. An upload against a record that does not ' +
      'exist still succeeds in Ivanti and leaves a file nobody can find.' +
      '\n\nTHE EXTENSION IS PART OF THE GATE, and it is checked only by Ivanti — after the ' +
      'bytes arrive, so a refusal costs the whole payload. The tenant allowlists by NAME, never ' +
      'by contents: measured on one tenant, `.txt`, `.csv`, `.xml`, `.png`, `.pdf`, `.docx` and ' +
      '`.zip` were accepted while `.log`, `.json`, `.md`, `.yaml`, `.conf` and `.sh` were ' +
      'refused — so the plain-text formats a log or a config arrives as are exactly the ones ' +
      'most likely to be rejected. Each tenant sets its own list. WHEN ATTACHING PASTED TEXT, ' +
      'NAME IT `.txt`.',
    annotations: {
      title: 'Upload attachment',
      readOnlyHint: false,
      // It adds a record; it does not change or remove anything that was there.
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object of the parent: `Incident#`, `Incidents` or `incident`.'),
      recordId: z.string().describe("The parent record's RecId."),
      filename: z.string().min(1).describe('The name to store the file under, with its extension.'),
      contentBase64: z.string().min(1).describe('The file, base64-encoded.'),
      contentType: z
        .string()
        .optional()
        .describe(`MIME type, e.g. \`image/png\`. Defaults to \`${DEFAULT_CONTENT_TYPE}\`.`),
    },
    handler: (args, context) =>
      runTool('upload_attachment', deps.logger, async () => {
        const transport = transportFor(deps.connection.transport, context);
        const target = await resolveObject(deps, args.object);

        // Their own record, and one still open: a file added to a closed ticket is invisible
        // to the process that closed it.
        await assertRecordWritable(deps, context, target, args.recordId);

        let bytes: Buffer;
        try {
          bytes = Buffer.from(args.contentBase64, 'base64');
        } catch {
          return errorResult('`contentBase64` is not valid base64, so there is nothing to upload.');
        }

        // Buffer.from accepts almost anything and silently drops what it cannot decode, so an
        // empty result means the input was not base64 rather than that the file was empty.
        if (bytes.byteLength === 0) {
          return errorResult(
            '`contentBase64` decoded to nothing. Either the file is empty or the value is not ' +
              'base64 — Ivanti would store an empty file either way.',
          );
        }

        if (bytes.byteLength > MAX_BYTES) {
          return errorResult(
            `'${args.filename}' is ${String(Math.round(bytes.byteLength / 1024))} KB, over the ` +
              `${String(MAX_BYTES / 1024 / 1024)} MB limit for a file sent through a tool call. ` +
              'Ask the person to attach it in Ivanti directly.',
          );
        }

        let uploaded: UploadedAttachment;
        try {
          uploaded = await uploadAttachment({
            transport,
            parentEntitySet: target.entitySet,
            // Ivanti wants the AdminUI form here, `Incident#`, not the entity set.
            parentObjectType: toObjectId(target.entity.name),
            parentRecId: args.recordId,
            // CSDL's name, so the link can be written in the tenant's casing.
            parentCategory: target.entity.name,
            filename: args.filename,
            bytes,
            contentType: args.contentType ?? DEFAULT_CONTENT_TYPE,
            // So the file is not stamped with this server's service account. Same attribution
            // rule as a record created through `create_record`.
            author: context.pin?.person()?.loginId,
          });
        } catch (error: unknown) {
          if (
            error instanceof OrphanedAttachmentError ||
            error instanceof AttachmentLinkUnconfirmedError
          ) {
            // Error level: nobody asked for a file in Ivanti that may be on no record, and
            // someone has to find out which it is.
            deps.logger.error('attachment uploaded but not attached', {
              object: target.entitySet,
              attachmentId: error.attachmentId,
              confirmed: error instanceof OrphanedAttachmentError,
            });
            return errorResult(`${error.message} ${remedy(error, deps.ownRecordsOnly)}`);
          }
          throw error;
        }

        deps.logger.info('ivanti attachment uploaded', {
          object: target.entitySet,
          bytes: uploaded.sizeBytes,
        });

        const { stored } = uploaded;
        return jsonResult({
          object: target.entitySet,
          recordId: args.recordId,
          attachmentId: uploaded.attachmentId,
          // What the attachment row says after the link, read back — not what was sent.
          filename: stored.name ?? uploaded.filename,
          sizeBytes: stored.sizeBytes ?? uploaded.sizeBytes,
          attached: true,
          // Who Ivanti recorded, from the row. These used to be asserted — `lastModBy` was
          // hard-coded to the service account, which is false the moment `act_as` opens an
          // impersonated session and the write runs as the person. A field the row does not
          // carry is left out rather than guessed.
          ...(stored.createdBy === undefined ? {} : { createdBy: stored.createdBy }),
          ...(stored.lastModBy === undefined ? {} : { lastModBy: stored.lastModBy }),
          ...(uploaded.linkReplyLost === undefined
            ? {}
            : {
                linkNote:
                  `The request linking the file failed (${uploaded.linkReplyLost.slice(0, 200)}), ` +
                  'but reading the file back shows it on the record — it IS attached. Do not ' +
                  'upload it again.',
              }),
        });
      }),
  });
}
