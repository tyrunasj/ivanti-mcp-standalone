// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildQuery, quoteOdataString, withQuery } from '../../ivanti/odata/query.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import { readRows } from '../shared/read-rows.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { assertOwnRecordById, missingRecordMessage } from '../shared/own-records.js';
import { errorResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { transportFor } from '../shared/transport-for.js';

/**
 * Reading an attached file, which is worth doing for some types and not others.
 *
 * A file comes back through the conversation, so it costs context by its size — and unlike the
 * upload direction there is no way to avoid that. Two kinds are worth the cost: a log or a
 * configuration dump, where the content *is* the diagnosis, and a screenshot, which a model can
 * actually read. A PDF or a spreadsheet is neither: it arrives as bytes nothing can interpret, so
 * it is refused with what it is rather than spent.
 */

/** Text this tool will decode. Anything else risks handing back mojibake as though it were content. */
const TEXT_TYPES = /^text\/|\/(json|xml|csv|x-yaml|yaml|javascript)\b/i;

/** What a model can actually look at. Other image types arrive as bytes it cannot use. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Images cost their whole size in context; text is capped separately because it is truncatable. */
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 20000;

/**
 * The most this tool fetches to show the start of a text file.
 *
 * Ivanti serves the whole file or nothing — there is no range request — so showing the first
 * 20,000 characters of a 200 MB log meant pulling 200 MB into this process first. Past this the
 * file is refused before any byte is requested.
 */
const MAX_FETCH_BYTES = 5 * 1024 * 1024;

/**
 * Extensions that name a model-viewable image, and ones that name something no model can read.
 *
 * Decided from the NAME, before fetching, because the only other evidence — the content type — is
 * in the reply, and waiting for it meant downloading a video to find out it was a video. The
 * name is only a first cut: what is fetched is still judged by what Ivanti says it is, below.
 * An extension on neither list is fetched and judged that way.
 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const UNREADABLE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'msg',
  'zip', '7z', 'rar', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'cab',
  'exe', 'msi', 'dll', 'bin', 'iso', 'dmg',
  'mp3', 'wav', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'wmv',
  'bmp', 'tif', 'tiff', 'heic', 'ico',
]);

/** A 3-byte file reported as "1 KB" reads as a rounding bug and makes the size useless. */
function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} bytes` : `${String(Math.round(bytes / 1024))} KB`;
}

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  return dot <= 0 || dot === name.length - 1 ? undefined : name.slice(dot + 1).toLowerCase();
}

function unreadable(name: string, described: string, size: string): string {
  return (
    `'${name}' is a ${described} of ${size}. That is not a format I can read — it would ` +
    'arrive as bytes with no meaning. Tell the person what the file is and offer to open it in ' +
    'Ivanti.'
  );
}

export function createDownloadAttachmentTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'download_attachment',
    title: 'Read an attachment',
    description:
      'Reads the contents of an attached file.\n\n' +
      'WORTH IT FOR logs, configuration dumps, CSVs and screenshots — where the file is the ' +
      'evidence. A log attached to a ticket usually says what the ticket does not.\n\n' +
      'NOT EVERY FILE CAN BE READ. Text comes back as text, truncated if long; PNG, JPEG, GIF ' +
      'and WebP come back as images. Anything else — PDF, Word, Excel, archives — is refused ' +
      'with its name, size and type, because it would arrive as bytes nothing can interpret. ' +
      'Say what it is and offer to open it in Ivanti instead.\n\n' +
      'The file crosses the conversation, so it costs context by its size. Check the size with ' +
      'get_attachment_details first when it might be large.',
    annotations: {
      title: 'Read an attachment',
      readOnlyHint: true,
      idempotentHint: true,
      // File contents are written by whoever attached them. Data, never instructions.
      openWorldHint: true,
    },
    inputSchema: {
      attachmentId: z.string().describe("The attachment's RecId, from get_related_records or get_attachment_details."),
    },
    handler: (args, context) =>
      runTool('download_attachment', deps.logger, async (): Promise<CallToolResult> => {
        const transport = transportFor(deps.connection.transport, context);

        const url = withQuery(
          transport.routes.entitySet('attachments'),
          buildQuery({ filter: `RecId eq ${quoteOdataString(args.attachmentId)}`, top: 1 }),
        );
        const row = readRows<OdataRecord>(await transport.request<OdataRecord>(url), url)[0];

        if (row === undefined) {
          // Same rule as get_attachment_details: to a scoped caller, an attachment that is not
          // there and one that is someone else's must read identically, or the difference is an
          // oracle over the tenant's attachment table — and this path returns BEFORE
          // `requirePerson`, so an unidentified caller could probe it too.
          return errorResult(
            missingRecordMessage(deps) ?? `No attachment with RecId ${args.attachmentId}.`,
          );
        }

        const name = typeof row['ATTACHNAME'] === 'string' ? row['ATTACHNAME'] : args.attachmentId;
        const parent = row['ParentLink_Category'];
        const parentRecId = row['ParentLink_RecID'];

        // A file is only as readable as the record it hangs off.
        if (typeof parent === 'string' && parent !== '' && !deps.gate.allows(parent)) {
          return errorResult(
            `That attachment belongs to a ${parent} record, which this server does not expose. ` +
              `It serves ${deps.gate.allowed.join(', ')}.`,
          );
        }

        if (deps.ownRecordsOnly) {
          if (
            typeof parent !== 'string' ||
            parent === '' ||
            typeof parentRecId !== 'string' ||
            parentRecId === ''
          ) {
            return errorResult(
              'That attachment is on no record, so I cannot tell whether it is yours. Refusing ' +
                'rather than guessing.',
            );
          }
          await assertOwnRecordById(deps, context, await resolveObject(deps, parent), parentRecId);
        }

        // Size and type are judged BEFORE the bytes are asked for. The row already carries the
        // size, and this used to download the whole file — a video, an archive, a 200 MB log —
        // only to refuse it or keep its first 20,000 characters.
        const declared =
          typeof row['AttachmentSize'] === 'number' && row['AttachmentSize'] >= 0
            ? row['AttachmentSize']
            : undefined;
        const extension = extensionOf(name);
        const imageLimit =
          `the ${String(MAX_IMAGE_BYTES / 1024)} KB limit for an image read through a conversation`;

        if (extension !== undefined && UNREADABLE_EXTENSIONS.has(extension)) {
          return errorResult(
            unreadable(
              name,
              `${extension.toUpperCase()} file`,
              declared === undefined ? 'unknown size' : sizeLabel(declared),
            ),
          );
        }
        if (declared !== undefined && extension !== undefined && IMAGE_EXTENSIONS.has(extension)) {
          if (declared > MAX_IMAGE_BYTES) {
            return errorResult(
              `'${name}' is ${sizeLabel(declared)}, over ${imageLimit}. Nothing was ` +
                'downloaded. Open it in Ivanti instead.',
            );
          }
        } else if (declared !== undefined && declared > MAX_FETCH_BYTES) {
          return errorResult(
            `'${name}' is ${sizeLabel(declared)}, over the ` +
              `${String(MAX_FETCH_BYTES / 1024 / 1024)} MB this tool will fetch — Ivanti serves ` +
              'the whole file or nothing, so even its first part cannot be read here. Nothing ' +
              'was downloaded. Offer to open it in Ivanti.',
          );
        }

        const { bytes, contentType } = await transport.requestBinary(
          withQuery(
            transport.routes.rest('Attachment'),
            `ID=${encodeURIComponent(args.attachmentId)}`,
          ),
          // A row with no size still must not be read whole: the same cap, enforced on the stream.
          { maxBytes: MAX_FETCH_BYTES },
        );

        const kind = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
        // The row's size where it has one: what came back may be only the first part of it.
        const size = sizeLabel(declared ?? bytes.byteLength);
        // Ivanti stores an unrecognised upload as `application/octet-stream`, so telling the
        // person "what the file is" needs the name when the type says nothing.
        const described =
          kind === '' || kind === 'application/octet-stream'
            ? `${extension?.toUpperCase() ?? 'binary'} file`
            : kind;

        if (TEXT_TYPES.test(kind)) {
          // Only the prefix that can be shown is decoded — four bytes is the most a character
          // takes — never the whole buffer. `stream` holds back a character cut in half at the
          // edge rather than rendering it as a replacement mark.
          const window = bytes.subarray(0, MAX_TEXT_CHARS * 4);
          const decoded = new TextDecoder().decode(window, { stream: true });
          const shown = decoded.slice(0, MAX_TEXT_CHARS);
          const partial =
            shown.length < decoded.length ||
            window.byteLength < bytes.byteLength ||
            (declared !== undefined && bytes.byteLength < declared);
          return {
            content: [
              {
                type: 'text',
                text:
                  `${name} (${kind}, ${size})` +
                  (partial ? ` — the first ${String(shown.length)} characters only` : '') +
                  `\n\n${shown}`,
              },
            ],
          };
        }

        if (IMAGE_TYPES.has(kind)) {
          if (bytes.byteLength > MAX_IMAGE_BYTES) {
            return errorResult(
              `'${name}' is ${size}, over ${imageLimit}. Open it in Ivanti instead.`,
            );
          }
          return {
            content: [
              { type: 'text', text: `${name} (${kind}, ${size})` },
              { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: kind },
            ],
          };
        }

        return errorResult(unreadable(name, described, size));
      }),
  });
}
