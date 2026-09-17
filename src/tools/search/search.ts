// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { buildQuery, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { scopeToOwnRecords } from '../shared/own-records.js';
import { IdentityRequiredError } from '../../auth/identity-pin.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { encodeRecordId, recordRecId, recordSummary, recordTitle } from './record-identity.js';
import { QUERY_WORDS, noHitsNote } from './query-words.js';
import { transportFor } from '../shared/transport-for.js';

/** Where a question usually lands when the asker did not say which object. */
const DEFAULT_OBJECTS = ['incidents', 'servicereqs', 'changes'] as const;
const PER_OBJECT_TOP = 10;
const MAX_RESULTS = 25;

export function createSearchTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'search',
    title: 'Search across Business Objects',
    description:
      'Keyword search ACROSS Business Objects — the one to reach for when you do not know ' +
      'which object holds the answer. Returns `{ results: [{ id, title, text }] }`, where ' +
      '`text` is a STATUS STRIP (status, priority, owner, dates) and NOT the record\'s own ' +
      'words — the description or symptom is not in it. Pass an `id` to `fetch` when the ' +
      'answer depends on what the record actually says.\n\n' +
      `Searches ${DEFAULT_OBJECTS.join(', ')} by default, ${String(PER_OBJECT_TOP)} hits each — ` +
      'the three Ivanti ships that hold most requests, NOT a statement about where this ' +
      "tenant's answers live. A tenant can define its own Business Objects, and anything the " +
      'default does not name is simply not searched. Pass `objects` to look elsewhere ' +
      '(list_business_objects says what exists); each one costs a request, so name only what ' +
      'you need.\n\n' +
      'This fans out Ivanti\'s per-object keyword search rather than using its cross-object ' +
      'search endpoint, which has been observed to answer an empty array for terms that ' +
      'per-object search matches dozens of times. An empty result means no match IN THE INDEXED TEXT, which is not the same as no such record: this searches the subject, description and notes Ivanti indexes, not every field. A value held in a structured field — a category, a chassis type, a filename — will not match even when it is exactly the word you searched. Say "nothing came up in the ticket text" rather than "there are none", and check with list_records and an `eq` filter before ruling it out.\n\n' +
      'A HIT YOU CANNOT FIND IN THE RECORD IS STILL A REAL HIT. On a service request the ' +
      'indexed text includes the ANSWERS given on its form, which are not fields on the record — ' +
      'so `fetch` can return every field and contain none of your search term. Read ' +
      'get_service_request_parameters with the request\'s id before calling such a match ' +
      'spurious.\n\n' +
      'For one known object use fulltext_search_object; for an exact value use list_records.',
    annotations: {
      title: 'Search across Business Objects',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      query: z.string().describe(QUERY_WORDS),
      objects: z
        .array(z.string())
        .optional()
        .describe(`Business Objects to search. Default: ${DEFAULT_OBJECTS.join(', ')}.`),
    },
    handler: (args, context) =>
      runTool('search', deps.logger, async () => {
        const transport = transportFor(deps.connection.transport, context);
        const objects = (args.objects ?? [...DEFAULT_OBJECTS]).filter((object) =>
          deps.gate.allows(object),
        );

        if (objects.length === 0) {
          return jsonResult({
            results: [],
            searched: [],
            note:
              deps.gate.allowed.length > 0
                ? `This server only exposes ${deps.gate.allowed.join(', ')}.`
                : 'No objects to search.',
          });
        }
        // Checked once, before the fan-out: inside it, a per-object failure is swallowed into
        // `skipped` so one unreadable object cannot empty the answer — which would turn "I do
        // not know who you are" into an empty result set, the one thing this must never be.
        if (deps.ownRecordsOnly && context.pin?.person() === undefined) {
          throw new IdentityRequiredError();
        }

        const skipped: { object: string; reason: string }[] = [];

        const found = await Promise.all(
          objects.map(async (object) => {
            try {
              const resolved = await resolveObject(deps, object);
              const { entitySet } = resolved;
              // Every object in the fan-out is narrowed on its own, because the field that ties
              // a record to a person is not the same field on each of them.
              const scoped = await scopeToOwnRecords(deps, context, resolved);
              const url = withQuery(
                transport.routes.entitySet(entitySet),
                buildQuery({ search: args.query, filter: scoped.filter, top: PER_OBJECT_TOP }),
              );
              const rows = readCollection<OdataRecord>(
                await transport.request<OdataRecord>(url),
                url,
              );

              // A row without a RecId cannot be fetched back, so it is not a result.
              return rows.flatMap((row) => {
                const recId = recordRecId(row);
                return recId === undefined
                  ? []
                  : [
                      {
                        id: encodeRecordId(entitySet, recId),
                        title: recordTitle(row),
                        text: recordSummary(row),
                      },
                    ];
              });
            } catch (error: unknown) {
              // One object the key cannot read must not empty the whole answer.
              skipped.push({
                object,
                reason: error instanceof Error ? error.message : 'failed',
              });
              return [];
            }
          }),
        );

        const results = found.flat().slice(0, MAX_RESULTS);
        // An object that could not be read was not searched. Reporting it under both keys said
        // two contradictory things at once, and the reassuring one is the one that gets believed.
        const failed = new Set(skipped.map((entry) => entry.object));
        const searched = objects.filter((object) => !failed.has(object));

        /**
         * That this answer is one person's, said in the payload.
         *
         * Every other read tool emits `scopedTo` and `list_records` teaches the rule "IF AND ONLY
         * IF the answer carries `scopedTo`, it means something weaker". Omitting the field here
         * turned that rule into an affirmative licence to read a one-person result as the whole
         * tenant: a tester was one sentence from "nobody has reported a printer problem" when the
         * truth was "you have no printer tickets".
         */
        const scopedTo = deps.ownRecordsOnly ? context.pin?.person()?.displayName : undefined;

        return jsonResult({
          // Emitted even when every object was skipped: dropping it there made a gate refusal
          // and a genuine empty answer the same shape, on the tool least able to afford it.
          ...(scopedTo === undefined ? {} : { scopedTo }),
          results,
          searched,
          ...(skipped.length > 0 ? { skipped } : {}),
          ...(results.length === 0
            ? {
                note:
                  (scopedTo === undefined
                    ? ''
                    : `This searched only ${scopedTo}'s own records, so an empty answer is TWO ` +
                      'claims at once: not in the indexed text, AND not theirs. Say the second ' +
                      'one — a record belonging to someone else answers zero here too. ') +
                  noHitsNote(args.query) +
                  ` Searched ${String(searched.length)} Business Object(s) of the ` +
                  `${String(objects.length)} asked for; the tenant has far more.`,
              }
            : {}),
        });
      }),
  });
}
