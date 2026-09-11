import { z } from 'zod';
import { decodeParameter } from '../../ivanti/service-request/parameter-shape.js';
import { parseFieldList, projectRows } from '../../ivanti/odata/projection.js';
import { buildQuery, quoteOdataString, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { ObjectNotAllowedError } from '../shared/object-gate.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/** The parameters live in their own Business Object, linked to the template by RecId. */
const PARAMETER_OBJECT = 'servicereqtemplateparams';

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
      'The questions one service request template asks — the form a requester fills in.\n\n' +
      'Takes the TEMPLATE RecId (from the service request template object), not a subscription ' +
      'id and not an offering name. A wrong id returns no parameters rather than an error.\n\n' +
      'Read `required` rather than `RequiredExpression`: the raw field is an expression and is a ' +
      'string either way, so `$(false)` looks true to a naive check. When `required` is absent ' +
      'the rule is conditional and only Ivanti can evaluate it — treat it as "ask anyway".\n\n' +
      'Parameters whose `DisplayType` is a list take their values from a validation list: use ' +
      'get_service_request_parameter_options for those instead of inventing values.',
    annotations: {
      title: 'Get service request parameters',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      templateId: z.string().describe('RecId of the service request template.'),
      fields: z
        .string()
        .optional()
        .describe('Comma-separated fields, if the default set is not what you need.'),
    },
    handler: (args) =>
      runTool('get_service_request_parameters', deps.logger, async () => {
        // These exist to serve service requests; where that object is gated away, so are they.
        if (!deps.gate.allows('ServiceReq')) {
          throw new ObjectNotAllowedError('ServiceReq', deps.gate.allowed);
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

        return jsonResult({
          templateId: args.templateId,
          returned: projected.length,
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
