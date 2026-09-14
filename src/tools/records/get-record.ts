// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { parseFieldList, projectRow } from '../../ivanti/odata/projection.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import {
  assertOwnRecord,
  hideMissingRecord,
  missingRecordMessage,
} from '../shared/own-records.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { ALL_FIELDS } from '../../ivanti/odata/compact-fields.js';

export function createGetRecordTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_record',
    title: 'Get record',
    description:
      'Fetches ONE record by its 32-character RecId — one round trip, no filter.\n\n' +
      'Use this only when you already hold the RecId (from a list or search result). If you ' +
      'have a human-facing identifier such as an incident number or a login, use list_records ' +
      'with a filter instead: `IncidentNumber eq 11150`.\n\n' +
      'IGNORE `IsInFinalState` — it is stored as `false` on every record including closed ones ' +
      '(measured across this tenant), so it cannot tell you whether a ticket is still open. ' +
      '`Status` and `ReadOnly` can.\n\n' +
      'Pass `fields` on every call you can. A bare incident is ~180 fields and ~10 KB of JSON, ' +
      'and you almost never need all of it. Names the object does not have come back in ' +
      '`ignoredFields` with a warning — never silently dropped — because ' +
      'the narrowing happens here rather than in Ivanti — Ivanti answers a projected ' +
      'single-record read with an empty body.',
    annotations: {
      title: 'Get record',
      readOnlyHint: true,
      idempotentHint: true,
      // Returns text people wrote into tickets: untrusted content.
      openWorldHint: true,
    },
    inputSchema: {
      object: z
        .string()
        .describe(
          'Business Object, in any of the three forms Ivanti spells them — the AdminUI id, the ' +
            'entity set, or the entity (`Incident#` / `Incidents` / `incident`, and the same ' +
            'shape for a Business Object this tenant defined itself). Names are tenant-specific: ' +
            'take them from list_business_objects rather than assuming the ones Ivanti ships.',
        ),
      recordId: z
        .string()
        .describe('The 32-character RecId. NOT an incident number or other human-facing id.'),
      fields: z
        .string()
        .optional()
        .describe('Comma-separated field names to return, e.g. "Subject,Status,Owner".'),
    },
    handler: (args, context) =>
      runTool('get_record', deps.logger, async () => {
        const resolved = await resolveObject(deps, args.object);
        const { entitySet } = resolved;
        const url = deps.connection.transport.routes.record(entitySet, args.recordId);

        // A scoped caller must not be able to tell "gone" from "not yours" — the read fails
        // before any ownership check can run, so the two are collapsed here instead.
        const record = await deps.connection.transport
          .request<OdataRecord>(url)
          .catch((error: unknown) => hideMissingRecord(deps, error));
        if (record === undefined) {
          return errorResult(
            missingRecordMessage(deps) ??
              `No ${entitySet} record with RecId ${args.recordId}. Ivanti returned an empty body, ` +
                'which for a read by key means the record is not there.',
          );
        }

        // Read, then refused: a single-record GET cannot be filtered, so ownership is checked
        // before anything is returned.
        await assertOwnRecord(deps, context, resolved, record);

        const fields = parseFieldList(args.fields);
        // A name the object does not have is dropped silently, so the key simply vanishes from
        // the answer and reads as "this record has no value for it". A tester asked employee for
        // `Manager` — which is `ManagerLink_RecID` here — and got a record with no sign that
        // anything had been asked for.
        const ignoredFields =
          fields === undefined
            ? []
            : fields.filter(
                (name) =>
                  name !== ALL_FIELDS &&
                  !Object.keys(record).some((key) => key.toLowerCase() === name.toLowerCase()),
              );

        return jsonResult({
          object: entitySet,
          ...(ignoredFields.length > 0
            ? {
                ignoredFields,
                note:
                  `This record has no field named ${ignoredFields.join(', ')}, so ${
                    ignoredFields.length === 1 ? 'it was' : 'they were'
                  } left out rather than returned empty. Call get_object_metadata with a ` +
                  '`search` for the right name — do not report the value as absent.',
              }
            : {}),
          record: fields === undefined ? record : projectRow(record, fields),
        });
      }),
  });
}
