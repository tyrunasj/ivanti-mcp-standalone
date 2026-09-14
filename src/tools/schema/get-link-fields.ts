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
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';

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
        .describe(
          'Business Object, in any of the three forms Ivanti spells them — the AdminUI id, the ' +
            'entity set, or the entity (`Incident#` / `Incidents` / `incident`, and the same ' +
            'shape for a Business Object this tenant defined itself). Names are tenant-specific: ' +
            'take them from list_business_objects rather than assuming the ones Ivanti ships.',
        ),
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
         */
        const observed = new Map<string, string>();
        const sampleUrl = withQuery(
          deps.connection.transport.routes.entitySet(entitySet),
          buildQuery({ top: SAMPLE_ROWS }),
        );
        const sample = await deps.connection.transport
          .request<OdataRecord>(sampleUrl)
          .then((payload) => readCollection<OdataRecord>(payload, sampleUrl))
          .catch(() => []);
        for (const row of sample) {
          for (const link of links) {
            const value = row[link.categoryField];
            if (typeof value === 'string' && value !== '' && !observed.has(link.categoryField)) {
              observed.set(link.categoryField, value);
            }
          }
        }

        const described = links.map((link) => {
          const categoryValue = observed.get(link.categoryField);
          return categoryValue === undefined ? link : { ...link, categoryValue };
        });

        return jsonResult({
          object: entity.name,
          count: links.length,
          links: described,
          note:
            'Write both fields of a pair in the same call — a RecId without its Category is ' +
            'refused. `categoryValue` is the string this tenant actually stores in that ' +
            "`_Category` field, taken from real records: use it verbatim. It is an object name " +
            'in the tenant’s own casing and may be dotted (a group object plus its extension, ' +
            'e.g. `ServiceAgreement.SLA`) — neither half alone is a valid value. A link with no ' +
            `\`categoryValue\` was simply unset on all ${String(SAMPLE_ROWS)} rows sampled.`,
        });
      }),
  });
}
