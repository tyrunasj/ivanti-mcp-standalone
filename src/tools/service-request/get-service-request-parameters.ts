import { z } from 'zod';
import { decodeParameter } from '../../ivanti/service-request/parameter-shape.js';
import { parseFieldList, projectRows } from '../../ivanti/odata/projection.js';
import { buildQuery, quoteOdataString, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { assertOwnRecordById } from '../shared/own-records.js';
import { resolveObject } from '../shared/resolve-object.js';
import { ObjectNotAllowedError } from '../shared/object-gate.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/** The parameters live in their own Business Object, linked to the template by RecId. */
const PARAMETER_OBJECT = 'servicereqtemplateparams';

/**
 * The answers a submitted request actually carries.
 *
 * Separate object from the template's parameters: `servicereqparams` holds one row per answered
 * parameter on one request. It is reached through the request rather than named directly, for
 * the same reason notes are — an end user may read the answers on *their* request, and the
 * object stays outside the allowlist so there is no way to read anyone else's.
 *
 * Without this a person could submit a request through this server and then have no way to ask
 * what they had submitted, which is the first thing anyone asks afterwards.
 */
const ANSWER_OBJECT = 'servicereqparams';

/**
 * What is worth returning out of the ~44 fields Ivanti sends per parameter.
 *
 * The first twelve are what a caller needs to render the prompt and submit a value. The last
 * five describe parameters Ivanti fills in **itself** — calculated or auto-filled — and without
 * them a caller cannot tell those apart from the ones a human must answer.
 */
const PARAMETER_FIELDS = [
  'RecId',
  'Name',
  'DisplayName',
  'DisplayType',
  'Description',
  'SequenceNum',
  'RequiredExpression',
  'VisibilityExpression',
  'ReadOnlyExpression',
  'ValidationList_RecID',
  'ValidationConstraints',
  'Price',
  'IsCalculated',
  'ValueExpression',
  'AutoFillExpression',
  'TriggerFields',
  'RequiresSubscription',
];

export function createGetServiceRequestParametersTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_service_request_parameters',
    title: 'Get service request parameters',
    description:
      'TWO QUESTIONS, ONE TOOL. Pass `templateId` for what an offering ASKS — before submitting. ' +
      'Pass `requestId` for what a submitted request ANSWERED — the natural follow-up to filing ' +
      'one, and the only way to read those answers back.\n\n' +
      'The questions one service request template asks — the form a requester fills in.\n\n' +
      'Takes the TEMPLATE RecId (from the service request template object), not a subscription ' +
      'id and not an offering name. A wrong id returns no parameters rather than an error.\n\n' +
      'Read `required` rather than `RequiredExpression`: the raw field is an expression and is a ' +
      'string either way, so `$(false)` looks true to a naive check. `required: true` is ' +
      'unconditional; absent WITH a `RequiredExpression` is conditional — read the expression, ' +
      'because a parameter can become required the moment another answer is given; absent with ' +
      'NO `RequiredExpression` is genuinely optional.\n\n' +
      '`VisibilityExpression` IS A CONDITION ON ANOTHER ANSWER ON THE SAME FORM, e.g. ' +
      '`$(IsThisForYou == false)`. A parameter whose expression is false is not on the form — do ' +
      'not answer it. Answering a hidden parameter, or omitting one your other answers have just ' +
      'revealed, is how a submit gets refused.\n\n' +
      'Parameters whose `DisplayType` is a list take their values from a validation list: use ' +
      'get_service_request_parameter_options for those instead of inventing values. A ' +
      '`DisplayType` of `category` is a SECTION HEADING, not a question — never answer it; ' +
      '`answerable` counts the rest.',
    annotations: {
      title: 'Get service request parameters',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      templateId: z
        .string()
        .optional()
        .describe(
          "RecId of the service request TEMPLATE — what an offering asks for, before anything " +
            'is submitted. From `templateId` on a list_request_offerings entry.',
        ),
      requestId: z
        .string()
        .optional()
        .describe(
          "RecId of a SUBMITTED request — what was actually answered on it. Use this for " +
            '"what did I ask for?" after submitting. Only on a request the caller owns.',
        ),
      fields: z
        .string()
        .optional()
        .describe('Comma-separated fields, if the default set is not what you need.'),
    },
    handler: (args, context) =>
      runTool('get_service_request_parameters', deps.logger, async () => {
        // These exist to serve service requests; where that object is gated away, so are they.
        if (!deps.gate.allows('ServiceReq')) {
          throw new ObjectNotAllowedError('ServiceReq', deps.gate.allowed);
        }

        if (args.requestId !== undefined && args.requestId !== '') {
          // Reached through the request, so it follows that request's ownership — the answers
          // object itself is never namable, and there is no route to anyone else's.
          const request = await resolveObject(deps, 'ServiceReq');
          await assertOwnRecordById(deps, context, request, args.requestId);

          const answersUrl = withQuery(
            deps.connection.transport.routes.entitySet(ANSWER_OBJECT),
            buildQuery({
              filter: `ParentLink_RecID eq ${quoteOdataString(args.requestId)}`,
              top: 100,
            }),
          );
          const answered = readCollection<OdataRecord>(
            await deps.connection.transport.request<OdataRecord>(answersUrl),
            answersUrl,
          );

          // A date answer stores the UTC instant of the chosen LOCAL day, so the raw value reads
          // back as the previous calendar date — narrating it verbatim tells the person they
          // asked for 30 September when they chose 1 October. The local day is what they picked.
          const offset = await deps.connection.serviceRequests.tenantOffset.get().catch(() => undefined);
          const localDay = (value: unknown): string | undefined => {
            if (typeof value !== 'string') return undefined;
            const at = Date.parse(value);
            if (Number.isNaN(at)) return undefined;
            return new Date(at + (offset?.minutes ?? 0) * 60_000).toISOString().slice(0, 10);
          };

          return jsonResult({
            requestId: args.requestId,
            returned: answered.length,
            answers: answered.map((row) => {
              const type = row['DisplayType'];
              const value = row['ParameterValue'];
              const day = type === 'date' ? localDay(value) : undefined;
              return {
                parameter: row['ParameterName'] ?? null,
                // What to say to the person. Ivanti's own display value is the raw instant on a
                // date, which is not the day they chose.
                displayValue: day ?? row['ParameterDisplayValue'] ?? value ?? null,
                value: value ?? null,
                type: type ?? null,
              };
            }),
            note:
              '`parameter` is the technical name the template uses; call this with `templateId` ' +
              'for the display names if you need to show the form back. A `date` answer is ' +
              'stored as a UTC instant — `displayValue` is the local day the person actually ' +
              'chose, and `value` is the raw instant.',
          });
        }

        if (args.templateId === undefined || args.templateId === '') {
          return errorResult(
            'Give me a `templateId` to see what an offering asks for, or a `requestId` to see ' +
              'what was answered on a request that already exists.',
          );
        }

        const url = withQuery(
          deps.connection.transport.routes.entitySet(PARAMETER_OBJECT),
          buildQuery({
            filter: `ParentLink_RecID eq ${quoteOdataString(args.templateId)}`,
            orderBy: 'SequenceNum',
            top: 100,
          }),
        );

        const payload = await deps.connection.transport.request<OdataRecord>(url);
        const rows = readCollection<OdataRecord>(payload, url);

        // Ivanti sends every field whatever is asked for, and a 16-parameter template is ~28 KB
        // of mostly UI layout. Dropping empties on top is safe here: for a form parameter,
        // absent means unset.
        const projected = projectRows(rows, parseFieldList(args.fields) ?? PARAMETER_FIELDS, {
          dropEmpty: true,
        });

        // Headings are not questions. Counting them as parameters sends a caller answering
        // four things that take no value, on Ivanti's one-refusal-at-a-time treadmill.
        const answerable = projected.filter(
          (parameter) => (parameter as { DisplayType?: unknown }).DisplayType !== 'category',
        ).length;

        return jsonResult({
          templateId: args.templateId,
          returned: projected.length,
          answerable,
          ...(answerable === projected.length
            ? {}
            : {
                answerableNote:
                  `${String(projected.length - answerable)} of these have DisplayType ` +
                  '`category`: they are section headings on the form, not questions. Do not ' +
                  'answer them.',
              }),
          ...(projected.length === 0
            ? {
                note:
                  'No parameters for that id. The most common cause is passing a subscription ' +
                  "or offering id instead of the template's RecId.",
              }
            : {}),
          parameters: projected.map(decodeParameter),
        });
      }),
  });
}
