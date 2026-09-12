import { z } from 'zod';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { ObjectNotAllowedError } from '../shared/object-gate.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/** Each option arrives as a row of cells: `[recId, value, label?]`. */
function toOption(row: unknown): { recId: string; value: string; label: string } | undefined {
  if (!Array.isArray(row) || row.length < 2) return undefined;

  // Cells arrive as strings, numbers or nulls; anything else is not a value a caller can submit.
  const cell = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  };

  const value = cell(row[1]);
  if (value === '') return undefined;

  return { recId: cell(row[0]), value, label: cell(row[2]) || value };
}

export function createGetServiceRequestParameterOptionsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_service_request_parameter_options',
    title: 'Get service request parameter options',
    description:
      'The legal values for one service request parameter whose type is a list.\n\n' +
      'Takes the parameter RecId from get_service_request_parameters. Some lists are ' +
      'CONSTRAINED by another answer on the same form — a site narrows the equipment, a ' +
      'category narrows the software. Those parameters carry `constraints`; pass the ' +
      "constraining parameter's `ConstraintFieldName` and the value chosen for it, or the list " +
      'comes back empty or wrong.\n\n' +
      'An empty list has three causes and the answer says which: no constraint supplied for a ' +
      'dependent list, a constraint whose value matches nothing, or a `search` term that does ' +
      'not begin an option label.',
    annotations: {
      title: 'Get service request parameter options',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      parameterId: z.string().describe('RecId of the parameter, from get_service_request_parameters.'),
      search: z
        .string()
        .optional()
        .describe(
          'Matches the START of the option LABEL, case-insensitively — not a substring, and ' +
            'never the value. `Bob` finds "Bob M Levitt"; `Levitt` finds nothing, and so does ' +
            '`BLevitt`, which is the value you would have to submit. Search by the first word, ' +
            'or omit it and read the whole list.',
        ),
      constraints: z
        .array(
          z.object({
            queryFieldName: z
              .string()
              .describe("The parameter's `ConstraintFieldName` from its constraints."),
            value: z.string().describe('The value chosen for the constraining parameter.'),
          }),
        )
        .optional()
        .describe('Values for the answers this list depends on.'),
      validationListId: z
        .string()
        .optional()
        .describe("The parameter's `ValidationList_RecID`, when it has one."),
    },
    handler: (args) =>
      runTool('get_service_request_parameter_options', deps.logger, async () => {
        // These exist to serve service requests; where that object is gated away, so are they.
        if (!deps.gate.allows('ServiceReq')) {
          throw new ObjectNotAllowedError('ServiceReq', deps.gate.allowed);
        }

        const { transport } = deps.connection;
        // A POST, despite being a read: the constraints travel in the body.
        const url = transport.routes.rest(
          `ServiceRequest/${encodeURIComponent(args.parameterId)}/ValidationList`,
        );

        const rows = await transport.request<unknown[]>(url, {
          method: 'POST',
          body: {
            constraintParams:
              args.constraints?.map((constraint) => ({
                queryFieldName: constraint.queryFieldName,
                value: constraint.value,
                condition: null,
              })) ?? null,
            parameterConfig: null,
            query: args.search ?? '',
            strCustomerLocation: '',
            strRecId: args.parameterId,
            strValidationName: '',
            strValidationRecId: args.validationListId ?? '',
            values: [],
          },
        });

        const options = Array.isArray(rows)
          ? rows.map(toOption).filter((option) => option !== undefined)
          : [];

        return jsonResult({
          parameterId: args.parameterId,
          returned: options.length,
          // Three different causes, and the old note named only one of them — so a caller whose
          // constraints were correct and whose `search` was simply the wrong shape was told to
          // go on supplying constraints. That cost one tester ~67 calls.
          ...(options.length === 0
            ? {
                note:
                  args.search !== undefined && args.search !== ''
                    ? `No options start with '${args.search}'. This matches the beginning of the ` +
                      'option label, not a substring and not the value — drop `search` and read ' +
                      'the whole list rather than trying another term.'
                    : 'No options. If this parameter is constrained by another answer, supply ' +
                      'that answer — a dependent list is empty rather than complete until its ' +
                      'parent is given.',
                ...(args.constraints === undefined || args.constraints.length === 0
                  ? {}
                  : { constraintsUsed: args.constraints }),
              }
            : {}),
          options,
        });
      }),
  });
}
