// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { linkFieldsOf } from '../../ivanti/session/form-context.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { buildQuery, withQuery } from '../../ivanti/odata/query.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import { readRows } from '../shared/read-rows.js';
import { OBJECT_ARGUMENT } from '../shared/object-argument.js';

/** One page is enough to see which links this tenant actually uses, and cheap. */
const SAMPLE_ROWS = 25;

export function createGetLinkFieldsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_link_fields',
    title: 'Get the link fields of an object',
    description:
      'The fields that point at another record, and the PAIR of fields each one is written ' +
      'through.\n\n' +
      'A link is not a column: it is a RecId field plus a `_Category` field naming the object the ' +
      'target lives in. Ivanti\'s refusals use the human label, which is neither — so this maps ' +
      'the label to the two fields you actually write.\n\n' +
      '**The mapping is per object, and the same field name can mean different things.** ' +
      'Measured on one tenant: `ProfileLink` is labelled "Customer" on an incident and ' +
      '"Contact Link" on a service request; a change has no `ProfileLink` and uses ' +
      '`RequestorLink`; knowledge articles have no links at all. Counts range from 0 to 21. Ask ' +
      'for the object you are about to write to.\n\n' +
      'Find the RecId to put in it with list_records or search against the target object.',
    annotations: {
      title: 'Get the link fields of an object',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z
        .string()
        .describe(OBJECT_ARGUMENT),
    },
    handler: (args) =>
      runTool('get_link_fields', deps.logger, async () => {
        const { entity, entitySet } = await resolveObject(deps, args.object);
        const form = await deps.connection.forms.get(toObjectId(entity.name));

        if (form === undefined) {
          return errorResult(
            `Ivanti has no create form for ${entity.name} that this role can reach, and the link ` +
              'fields live on the form. get_object_metadata still lists the fields; the ones ' +
              'ending `_RecID` are links.',
          );
        }

        const links = linkFieldsOf(form);

        /**
         * What each `_Category` field actually holds, read off real rows rather than described.
         *
         * The tool named the pair and stopped there, which left the hardest half unanswered: the
         * Category is an object NAME in the tenant's own casing, and some of them are dotted —
         * measured on this tenant, `SLALink_Category` is `ServiceAgreement.SLA`, a group business
         * object plus its extension. Nothing about the field name says that, and a caller
         * guessing `SLA` or `ServiceAgreement` writes a link that is accepted and points nowhere.
         *
         * One page of rows, best effort: a value here is a value this tenant has really stored.
         *
         * EVERY distinct value, not the first. A link can point at more than one object — a
         * customer is an employee or an external contact — and reporting whichever the first row
         * held, with "use it verbatim", sent every link of the other kind to the wrong object.
         */
        const observed = new Map<string, Set<string>>();
        const sampleUrl = withQuery(
          deps.connection.transport.routes.entitySet(entitySet),
          buildQuery({ top: SAMPLE_ROWS }),
        );
        const sample = await deps.connection.transport
          .request<OdataRecord>(sampleUrl)
          .then((payload) => readRows<OdataRecord>(payload, sampleUrl))
          .catch(() => []);
        for (const row of sample) {
          for (const link of links) {
            const value = row[link.categoryField];
            if (typeof value !== 'string' || value === '') continue;
            const seen = observed.get(link.categoryField) ?? new Set<string>();
            seen.add(value);
            observed.set(link.categoryField, seen);
          }
        }

        const described = links.map((link) => {
          const seen = observed.get(link.categoryField);
          return seen === undefined ? link : { ...link, categoryValues: [...seen].sort() };
        });

        return jsonResult({
          object: entity.name,
          count: links.length,
          links: described,
          note:
            'Write both fields of a pair in the same call — a RecId without its Category is ' +
            'refused. `categoryValues` are the strings this tenant actually stores in that ' +
            '`_Category` field, taken from real records: write one verbatim. Where there is more ' +
            'than one, the link points at more than one kind of object — write the one that ' +
            'names the object the RecId came from. Each is an object name in the tenant’s own ' +
            'casing and may be dotted (a group object plus its extension, e.g. ' +
            '`ServiceAgreement.SLA`) — neither half alone is a valid value. A link with no ' +
            `\`categoryValues\` was simply unset on all ${String(SAMPLE_ROWS)} rows sampled, and ` +
            'the values listed are only those the sample held, not every one the link accepts.',
        });
      }),
  });
}
