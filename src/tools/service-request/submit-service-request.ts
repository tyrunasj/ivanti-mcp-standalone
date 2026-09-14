// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { stageAttachment, type StagedAttachment } from '../../ivanti/service-request/stage-attachment.js';
import {
  buildSubmitPayload,
  submitWithAttachments,
  isChosenOption,
  ISO_DATETIME,
  readSubmitReply,
  verifyStoredAnswers,
  type ParameterAnswer,
} from '../../ivanti/service-request/submit.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { resolveSubject } from '../shared/own-records.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import { connectionFor } from '../shared/connection-for.js';
import { ObjectNotAllowedError } from '../shared/object-gate.js';

/** An answer is either a plain value or a chosen option carrying its identifier. */
const ANSWER = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.object({
    value: z.string().describe("The option's value, from get_service_request_parameter_options."),
    recId: z.string().describe("That option's `recId`. A combo is refused without it."),
  }),
]);

/** The same ceiling the attachment tools use, and for the same reason: base64 crosses twice. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function createSubmitServiceRequestTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'submit_service_request',
    title: 'Submit service request',
    description:
      'Files a service request from the catalog, on behalf of a person.\n\n' +
      'ORDER: list_request_offerings for the ids, get_service_request_parameters for what the ' +
      'offering asks, get_service_request_parameter_options for any `combo`, then this. ' +
      '`subscriptionId` and `templateId` must come from the SAME offering.\n\n' +
      'ANSWERS ARE KEYED BY PARAMETER RecId. A `combo` parameter must be answered as ' +
      '`{value, recId}` — a bare value is refused with "validation list\'s value was submitted ' +
      'without it\'s identifier". A checkbox takes a real boolean and BOTH `true` and `false` ' +
      'store — the encoding is what is fussy: `True`, `1` and `yes` are silently ignored and ' +
      'echoed back unchanged, so pass a real boolean and let this tool encode it.\n\n' +
      'IVANTI ANSWERS 200 WHEN IT REFUSES. A refusal names one missing parameter at a time, so ' +
      'expect another after fixing the first. Nothing is created by a refusal.\n\n' +
      'PREFER PASSING FILES HERE: they are staged with the form and are on the request the moment ' +
      'it exists. They can also be added afterwards with `upload_attachment` — `object: ' +
      '"ServiceReq"` and the request\'s RecId — which is what to use when the person produces a ' +
      'document after filing. Do not tell them a file cannot be added later; it can.\n\n' +
      'A `datetime` PARAMETER TAKES `YYYY-MM-DDTHH:MM` in the tenant\'s local time; plain DATES TAKE `YYYY-MM-DD`. Ivanti reads anything else as US month/day/year, so `01/10/2026` ' +
      'is stored as 9 January. A date that lands wrong is reported by the read-back — but the ' +
      'request has already been created by then, so getting it right first time matters.\n\n' +
      'The request is READ BACK and the answers compared with what was sent. A date that landed ' +
      'on the wrong day or an answer Ivanti dropped is reported — neither is visible in what ' +
      'Ivanti says about its own submit.',
    annotations: {
      title: 'Submit service request',
      readOnlyHint: false,
      destructiveHint: false,
      // Each call files another request; a retry after an unclear failure duplicates it.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      subscriptionId: z
        .string()
        .describe("The offering's `subscriptionId` — NOT its `templateId`."),
      answers: z
        .record(z.string(), ANSWER)
        .describe(
          "Keyed by the parameter's RecId from get_service_request_parameters. A combo is " +
            '`{value, recId}`; everything else is a plain value.',
        ),
      subject: z
        .string()
        .optional()
        .describe(
          "Proposed subject. MOST OFFERINGS IGNORE IT — the template computes the subject from " +
            'itself, and the read-back does not check this field, so a request commonly comes ' +
            "back titled after the offering whatever is passed here. Do not promise the person " +
            'their wording will appear.',
        ),
      person: z
        .string()
        .optional()
        .describe(
          'Who the request is for, as their RecId. Defaults to whoever this conversation is ' +
            'acting for.',
        ),
      attachments: z
        .array(
          z.object({
            filename: z
              .string()
              .min(1)
              .describe(
                'The name to store the file under. THE EXTENSION DECIDES whether Ivanti accepts ' +
                  'it at all — this tenant allowlists extensions by NAME, not by contents, so ' +
                  '`.log` is refused where the identical bytes are accepted as `.txt`.',
              ),
            contentBase64: z.string().min(1).describe('The file, base64-encoded.'),
            contentType: z.string().optional().describe('MIME type. Defaults to application/octet-stream.'),
          }),
        )
        .optional()
        .describe(
          'Files to attach. Staged and bound as part of this submit, so they are on the ' +
            'request the moment it exists — which is why files collected on the form belong ' +
            'here. A file the person produces LATER can still be added with upload_attachment ' +
            "(`object: \"ServiceReq\"` and the request's RecId). Each is capped at 2 MB, and " +
            'base64 costs context twice over.',
        ),
      localOffsetMinutes: z
        .number()
        .int()
        .optional()
        .describe(
          'Only if a date lands wrong. Ivanti wants the tenant UTC offset NEGATED (UTC+2 → ' +
            '-120); it is discovered automatically, and the sign matters — the positive value ' +
            'stores year 0001 while reporting success.',
        ),
    },
    handler: (args, context) =>
      runTool('submit_service_request', deps.logger, async () => {
        // The same gate its sibling parameter tools apply, and for the same reason: this writes a
        // `ServiceReq` and then reads two of them back — `servicereqs('<id>')` and its parameter
        // relationship — surfacing `ProfileFullName` and `CreatedBy` from a gated object. Every
        // other object-taking tool passes through `createObjectGate`; this one did not, so an
        // enduser deployment whose allowlist omits ServiceReq could still create one.
        if (!deps.gate.allows('ServiceReq')) {
          throw new ObjectNotAllowedError('ServiceReq', deps.gate.allowed);
        }

        const connection = connectionFor(deps, context);
        const personRecId = resolveSubject(deps, context, args.person, (person) => person.recId);

        if (personRecId === undefined) {
          return errorResult(
            'Who is this request for? A service request is filed against a person, so this ' +
              'needs one: call `act_as` with the name of the person you are helping, or pass ' +
              '`person` with their RecId.',
          );
        }

        const answers = args.answers as Record<string, ParameterAnswer>;
        const sendsDate = Object.values(answers).some((answer) => {
          const raw = isChosenOption(answer) ? answer.value : answer;
          return typeof raw === 'string' && ISO_DATETIME.test(raw);
        });

        // Only looked up when it can matter: without a datetime the offset changes nothing.
        let localOffset = args.localOffsetMinutes ?? 0;
        let offsetNote: string | undefined;
        if (args.localOffsetMinutes === undefined && sendsDate) {
          const tenant = await connection.serviceRequests.tenantOffset.get();
          if (tenant === undefined) {
            offsetNote =
              'The tenant UTC offset could not be read, so dates were sent unadjusted and may ' +
              'have landed a day out. Check the stored values below.';
          } else {
            localOffset = -tenant.minutes;
          }
        }

        const submitRequest = {
          transport: connection.transport,
          subscriptionId: args.subscriptionId,
          personRecId,
          answers,
          localOffset,
          ...(args.subject === undefined ? {} : { subject: args.subject }),
        };

        // Staged here rather than by a separate tool, so the staging id never leaves this server.
        // Ivanti keeps ONE attachment record behind a staging id, so a second submit carrying it
        // would MOVE the file off the first request — a token nothing can reuse cannot do that.
        const files = args.attachments ?? [];
        const staged: StagedAttachment[] = [];
        for (const file of files) {
          const bytes = Buffer.from(file.contentBase64, 'base64');
          if (bytes.byteLength === 0) {
            return errorResult(
              `'${file.filename}' decoded to nothing — either it is empty or the value is not ` +
                'base64. Nothing was submitted.',
            );
          }
          if (bytes.byteLength > MAX_FILE_BYTES) {
            return errorResult(
              `'${file.filename}' is ${String(Math.round(bytes.byteLength / 1024))} KB, over the ` +
                `${String(MAX_FILE_BYTES / 1024 / 1024)} MB limit for a file sent through a tool ` +
                'call. Nothing was submitted.',
            );
          }
          staged.push(
            await stageAttachment({
              session: connection.session,
              subscriptionId: args.subscriptionId,
              customerLocation: '',
              filename: file.filename,
              bytes,
              contentType: file.contentType ?? 'application/octet-stream',
            }),
          );
        }

        // Files force the ASMX path: REST takes an `attachments` field and drops it silently.
        const reply =
          staged.length > 0
            ? await submitWithAttachments(connection.session, submitRequest, staged)
            : await connection.transport.requestRequired<unknown>(
                connection.transport.routes.rest('ServiceRequest/new'),
                { method: 'POST', body: buildSubmitPayload(submitRequest) },
              );

        // Throws on a refusal, which Ivanti delivers inside a 200.
        const submitted = readSubmitReply(reply, Object.keys(answers).length);

        deps.logger.info('ivanti service request submitted', {
          requestNumber: submitted.requestNumber,
        });

        /**
         * Whose request this actually is, read off the record rather than assumed from the pin.
         *
         * `filedFor` used to echo whoever `act_as` pinned, so a request correctly filed for
         * someone else was reported under the pinned account's name — the write right, the
         * narration wrong, and nothing downstream to contradict it.
         */
        const filed = await connection.transport
          .request<OdataRecord>(
            connection.transport.routes.record('servicereqs', submitted.recId),
          )
          .catch(() => undefined);
        const filedForName =
          typeof filed?.['ProfileFullName'] === 'string' ? filed['ProfileFullName'] : undefined;

        // Ivanti reports a submit as successful without checking that the answers stored.
        // The `.catch` itself is right and stays: the request EXISTS by now, and letting a
        // failed read-back turn a filed request into a reported failure would be worse than not
        // checking. What was wrong is that its result was indistinguishable from "nothing
        // mismatched" — `check === undefined` rendered as `answersVerified: true`, next to an
        // `answerNote` promising "the comparison below does" confirm the answers individually.
        // A 500, a 10 s timeout, an expired impersonated SID or unrecognised prose in `value` all
        // produced an unearned claim of verification.
        const check = await verifyStoredAnswers(
          connection.transport,
          submitted.recId,
          answers,
          localOffset,
        ).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));

        const verification = check instanceof Error ? undefined : check;
        const verifyFailed = check instanceof Error ? check : undefined;

        return jsonResult({
          requestNumber: submitted.requestNumber,
          name: submitted.name ?? null,
          recId: submitted.recId,
          // Whose request this IS, read back from the record rather than from the pin. This
          // reported the pinned account even when `person` filed it for someone else — so a
          // model narrated "I've filed this for you, <pinned name>" and named the wrong
          // employee on a request heading for approval.
          filedFor: filedForName ?? personRecId,
          // From the RECORD, not from the pin. An earlier `filedBy: <pinned name>` sat beside
          // `filedFor`, which is a verified record fact, so the pair read as though both came
          // from Ivanti — and Ivanti had stamped the service account. Narrating it named the
          // right beneficiary and the wrong filer.
          ...(typeof filed?.['CreatedBy'] === 'string'
            ? { createdBy: filed['CreatedBy'], createdByNote: 'who Ivanti recorded as filing it' }
            : {}),
          answersSent: submitted.parametersSent,
          answersOnRequest: submitted.parametersOnRequest,
          ...(staged.length === 0 ? {} : { attached: staged.map((file) => file.filename) }),
          ...(submitted.parametersOnRequest !== submitted.parametersSent
            ? {
                answerNote:
                  `Ivanti put ${String(submitted.parametersOnRequest)} answers on the request ` +
                  `while ${String(submitted.parametersSent)} were sent. That count is Ivanti's ` +
                  'own and includes the template\'s defaults, so it does not confirm yours ' +
                  'individually — the comparison below does.',
              }
            : {}),
          ...(offsetNote === undefined ? {} : { offsetWarning: offsetNote }),
          ...(verifyFailed !== undefined
            ? {
                // Three states, not two. The request was filed; whether it stored correctly is
                // unknown, and saying so is the only honest answer.
                answersVerified: 'unknown',
                verifyWarning:
                  'The request was created, but reading it back to check the answers failed: ' +
                  `${verifyFailed.message.slice(0, 200)}. Ivanti reports a submit as clean ` +
                  'without checking that the answers stored, so this is NOT a confirmation that ' +
                  'they did. Read the request in Ivanti, or call get_service_request_parameters ' +
                  'with its requestId.',
              }
            : verification === undefined ||
                (verification.mismatches.length === 0 && verification.missing.length === 0)
              ? { answersVerified: true }
              : {
                  answersVerified: false,
                  ...(verification.mismatches.length > 0
                    ? { storedDifferently: verification.mismatches }
                    : {}),
                  ...(verification.missing.length > 0 ? { notStored: verification.missing } : {}),
                  warning:
                    'The request exists, but what Ivanti stored is not what was sent. This was ' +
                    'found by reading the request back — Ivanti reported the submit as clean.',
                }),
        });
      }),
  });
}
