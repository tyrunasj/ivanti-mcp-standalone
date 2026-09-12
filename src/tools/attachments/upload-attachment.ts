import { z } from 'zod';
import { uploadAttachment } from '../../ivanti/attachments/upload.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { assertRecordWritable } from '../shared/own-records.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

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

        const uploaded = await uploadAttachment({
          transport: deps.connection.transport,
          parentEntitySet: target.entitySet,
          // Ivanti wants the AdminUI form here, `Incident#`, not the entity set.
          parentObjectType: toObjectId(target.entity.name),
          parentRecId: args.recordId,
          // What `ParentLink_Category` holds: the object name without the `#`.
          parentCategory: target.entity.name,
          filename: args.filename,
          bytes,
          contentType: args.contentType ?? DEFAULT_CONTENT_TYPE,
          // So the file is not stamped with this server's service account. Same attribution rule
          // as a record created through `create_record`.
          author: context.pin?.person()?.loginId,
        });

        deps.logger.info('ivanti attachment uploaded', {
          object: target.entitySet,
          bytes: uploaded.sizeBytes,
        });

        return jsonResult({
          object: target.entitySet,
          recordId: args.recordId,
          attachmentId: uploaded.attachmentId,
          filename: uploaded.filename,
          sizeBytes: uploaded.sizeBytes,
          attached: true,
          // Both halves, because Ivanti stores both and they differ. `CreatedBy` is the person
          // this was filed for and is overridable; `LastModBy` is not, and always records the
          // account that performed the write. Reporting only the first answered "who added it"
          // with half the truth, and a caller asking exactly that had to spend another call.
          createdBy: context.pin?.person()?.loginId ?? 'this server’s service account',
          lastModBy: 'this server’s service account (Ivanti will not let that be overridden)',
        });
      }),
  });
}
