// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { ObjectNotAllowedError } from '../shared/object-gate.js';
import {
  assertOwnRecord,
  hideMissingRecord,
  missingRecordMessage,
} from '../shared/own-records.js';
import { resolveObject } from '../shared/resolve-object.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { decodeRecordId, recordTitle } from './record-identity.js';
import { transportFor } from '../shared/transport-for.js';

export function createFetchTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'fetch',
    title: 'Fetch a search result',
    description:
      'Retrieves the full record behind a `search` result. Takes the `id` from that result, ' +
      'which encodes both the Business Object and the record — a RecId alone does not say what ' +
      'it belongs to.\n\n' +
      'Returns every field. Use get_record with `fields` when you want a narrower answer.' +
      '\n\nSCOPED LIKE `search`: where this server answers for one person, an id for someone ' +
      "else's record is refused in the same words as an id that does not exist — the answer " +
      'carries `scopedTo` when it is narrowed. And a service request\'s FORM ANSWERS are ' +
      'searchable but are not fields here, so a `search` hit whose term appears nowhere in this ' +
      'record is not a false positive: read get_service_request_parameters for it.',
    annotations: {
      title: 'Fetch a search result',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      id: z.string().describe('An `id` from a search result, e.g. `incidents:8E71…`.'),
    },
    handler: (args, context) =>
      runTool('fetch', deps.logger, async () => {
        const transport = transportFor(deps.connection.transport, context);
        const decoded = decodeRecordId(args.id);
        if (decoded === undefined) {
          return errorResult(
            `'${args.id}' is not a fetchable id. Ids come from search results and look like ` +
              '`incidents:8E71E727DD5045C7B11EF634233437F1`. To read a record you already have ' +
              'the RecId for, use get_record, which takes the object separately.',
          );
        }

        // An id is a name for an object, so it passes the same gate as one typed by hand.
        if (!deps.gate.allows(decoded.entitySet)) {
          throw new ObjectNotAllowedError(decoded.entitySet, deps.gate.allowed);
        }

        const url = transport.routes.record(decoded.entitySet, decoded.recId);
        const record = await transport
          .request<OdataRecord>(url)
          .catch((error: unknown) => hideMissingRecord(deps, error));

        if (record === undefined) {
          return errorResult(
            missingRecordMessage(deps) ??
              `No ${decoded.entitySet} record with RecId ${decoded.recId}.`,
          );
        }

        // The id names the object, so ownership is checked against that object's own person
        // link rather than assumed from where the id came from.
        await assertOwnRecord(deps, context, await resolveObject(deps, decoded.entitySet), record);

        return jsonResult({
          // Same rule as search: an answer narrowed to one person says so.
          ...(deps.ownRecordsOnly && context.pin?.person() !== undefined
            ? { scopedTo: context.pin.person()?.displayName }
            : {}),
          id: args.id,
          title: recordTitle(record),
          metadata: { object: decoded.entitySet, recId: decoded.recId },
          record,
        });
      }),
  });
}
