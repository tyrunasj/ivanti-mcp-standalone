import { z } from 'zod';
import { buildQuery, quoteOdataString, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import { readPickLists } from '../../ivanti/session/pick-lists.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { scopeToOwnRecords } from '../shared/own-records.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/** Each bucket is its own round trip, so the fan-out is capped. */
const MAX_BUCKETS = 25;

interface Bucket {
  value: string;
  count?: number;
  exact?: boolean;
  error?: string;
}

const countOf = (bucket: Bucket): number => bucket.count ?? -1;

export function createGroupCountTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'group_count',
    title: 'Count records by value',
    description:
      '"How many incidents per status", "how many changes by priority" — a count for each value ' +
      'of one field.\n\n' +
      'Ivanti has no aggregation endpoint, so this is one count per value and the values have to ' +
      'come from somewhere: the field\'s own list when it is validated, or `values` when you ' +
      'name them. That makes it **honest but not cheap** — it is capped at ' +
      `${String(MAX_BUCKETS)} buckets, and a field with hundreds of values is the wrong ` +
      'question for this tool.\n\n' +
      'Every bucket carries its own `exact` flag, the same contract as count_records. The ' +
      'buckets themselves come from the field\'s validation list, and records holding a value ' +
      'that list no longer offers fall into NO bucket — so the answer also reports `total` and ' +
      '`unaccounted`. A non-zero `unaccounted` means this is a partial picture, not a breakdown.',
    annotations: {
      title: 'Count records by value',
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
      groupBy: z.string().describe('The field to count by, e.g. "Status".'),
      values: z
        .array(z.string())
        .optional()
        .describe('Count only these values. Required when the field is not a validated list.'),
      filter: z
        .string()
        .optional()
        .describe('Narrow every bucket, e.g. "CreatedDateTime gt 2026-01-01".'),
    },
    handler: (args, context) =>
      runTool('group_count', deps.logger, async () => {
        const resolved = await resolveObject(deps, args.object);
        const { entity, entitySet } = resolved;
        const scoped = await scopeToOwnRecords(deps, context, resolved, args.filter);

        let values = args.values ?? [];
        let valuesFrom = 'caller';

        if (values.length === 0) {
          const form = await deps.connection.forms.get(toObjectId(entity.name));
          if (form === undefined) {
            return errorResult(
              `No form for ${entity.name} is reachable, so the values of '${args.groupBy}' ` +
                'cannot be listed. Pass `values` with the ones to count.',
            );
          }

          const { lists } = await readPickLists({
            session: deps.connection.session,
            form,
            objectId: toObjectId(entity.name),
            fields: [args.groupBy],
          });

          const list = lists[args.groupBy];
          if (list === undefined || !list.validated || list.values.length === 0) {
            return errorResult(
              `'${args.groupBy}' is not a validated field on ${entity.name}, or its list is ` +
                'empty, so there is nothing to group over. Pass `values` with the ones to count.',
            );
          }

          values = list.values.map((option) => option.value);
          valuesFrom = 'the field’s own list';
        }

        const counted = values.slice(0, MAX_BUCKETS);

        // One request per bucket, together rather than in series.
        const groups: Bucket[] = await Promise.all(
          counted.map(async (value): Promise<Bucket> => {
            const conditions = [`${args.groupBy} eq ${quoteOdataString(value)}`];
            // Already carries the own-records constraint in `enduser` mode.
            if (scoped.filter !== undefined && scoped.filter !== '')
              conditions.push(`(${scoped.filter})`);

            const url = withQuery(
              deps.connection.transport.routes.entitySet(entitySet),
              buildQuery({ filter: conditions.join(' and '), top: 1, count: true }),
            );

            try {
              const payload = await deps.connection.transport.request<OdataRecord>(url);
              const rows = readCollection<OdataRecord>(payload, url);
              const total = readTotal(payload, rows.length);
              // No count and no rows is Ivanti's empty body: an exact zero.
              return total === undefined
                ? { value, count: rows.length, exact: rows.length === 0 }
                : { value, count: total.total, exact: total.exact };
            } catch (error: unknown) {
              return {
                value,
                error: error instanceof Error ? error.message.slice(0, 120) : 'failed',
              };
            }
          }),
        );

        // The buckets come from a create form's validation list, and records can hold values that
        // list no longer offers — measured, four of a change's seven statuses were missing and the
        // buckets summed to 12 of 51. Every bucket said `exact: true`, because each count was
        // right; it was the set of buckets that was short. So the whole is compared against the
        // real total and the shortfall reported, rather than left to be noticed.
        const bucketTotal = groups.reduce((sum, group) => sum + countOf(group), 0);
        const wholeUrl = withQuery(
          deps.connection.transport.routes.entitySet(entitySet),
          buildQuery({ filter: scoped.filter, top: 1, count: true }),
        );
        const whole = await deps.connection.transport
          .request<OdataRecord>(wholeUrl)
          .then((payload) => readTotal(payload, 0))
          .catch(() => undefined);
        const unaccounted = whole === undefined ? undefined : whole.total - bucketTotal;

        return jsonResult({
          object: entity.name,
          ...(scoped.scopedTo === undefined ? {} : { scopedTo: scoped.scopedTo }),
          groupBy: args.groupBy,
          valuesFrom,
          ...(whole === undefined ? {} : { total: whole.total }),
          ...(unaccounted === undefined || unaccounted <= 0
            ? {}
            : {
                unaccounted,
                // The wording has to follow where the values came from. Said the old way to a
                // caller who had named two of seventeen departments himself, it read as "your
                // tenant's data is dirty" when it meant "you asked about two buckets" — there
                // was no field's list involved at all.
                warning:
                  valuesFrom === 'caller'
                    ? `${String(unaccounted)} of ${String(whole?.total ?? 0)} records hold a ` +
                      `'${args.groupBy}' value you did NOT name, or none at all, so they are in ` +
                      'no bucket below. This counts the values you asked about, not the whole ' +
                      'field — omit `values` to group by the field’s own list instead.'
                    : `${String(unaccounted)} of ${String(whole?.total ?? 0)} records hold a ` +
                      `'${args.groupBy}' value that is not on the field's list, or none at all, ` +
                      'so they are in no bucket below. This is a partial picture — do not ' +
                      'present it as a breakdown of the whole.',
              }),
          ...(values.length > counted.length ? { truncated: values.length } : {}),
          // Biggest bucket first: that is the shape of the answer, and a bucket that failed
          // sorts last rather than pretending to be a zero.
          groups: [...groups].sort((a, b) => countOf(b) - countOf(a)),
        });
      }),
  });
}
