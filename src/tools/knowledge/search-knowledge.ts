import { z } from 'zod';
import { buildQuery, MAX_TOP, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/**
 * The knowledge base, which has an audience rule the object gate cannot express.
 *
 * A knowledge article moves through Draft → In Review → Reviewed → **Published** → Expired →
 * Archived, and Ivanti's own self-service portal searches **only Published**. The rest are
 * internal: drafts, articles under review, and ones that were rejected. On this tenant that is 27
 * published against 18 that are not — so an unfiltered search would hand an end user somebody's
 * draft or a rejected article as though it were advice.
 *
 * That is why this is a tool rather than `FRS_Knowledge` in `ENDUSER_BUSINESS_OBJECTS`: the
 * allowlist can say *which objects*, but not *which rows of one*. Reaching the knowledge base only
 * through here keeps the audience rule somewhere it cannot be bypassed by naming the object.
 */

/** What the self-service portal shows. Everything else is an internal state. */
const PUBLISHED = 'Published';

/** Articles are authored in the rich-text editor, so `Details` is HTML. */
const DEFAULT_EXCERPT = 600;

function toText(html: unknown): string | undefined {
  if (typeof html !== 'string' || html.trim() === '') return undefined;
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|ol|ul|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Reading one article whole, which the record tools cannot do.
 *
 * `FRS_Knowledge` is a **base type**: it carries the title, status and summary, and the actual
 * answer lives on a subtype — an IssueResolution's fix is in `Resolution`, which is invisible from
 * the base. `FRS_KnowledgeType` on the base row names which (`IssueResolution` →
 * `frs_knowledge__issueresolution`). And in `enduser` the knowledge object is outside the gate
 * entirely, so there is no record-tool path to an article at all.
 *
 * The body is found by difference rather than by a per-subtype list of field names: whatever
 * fields the subtype has that the base type does not **are** what the subtype adds, which is the
 * article's content. That holds for all six subtypes without naming any of them.
 */
async function readWholeArticle(
  deps: IvantiToolDeps,
  base: OdataRecord,
): Promise<Record<string, string>> {
  const type = base['FRS_KnowledgeType'];
  const recId = base['RecId'];
  if (typeof type !== 'string' || type === '' || typeof recId !== 'string') return {};

  const subtypeName = `frs_knowledge__${type.toLowerCase()}`;
  const [subtype, baseType] = await Promise.all([
    deps.connection.metadata.entity(subtypeName).catch(() => undefined),
    deps.connection.metadata.entity('frs_knowledge').catch(() => undefined),
  ]);
  if (subtype === undefined) return {};

  const inherited = new Set((baseType?.fields ?? []).map((field) => field.name));
  const added = subtype.fields
    .map((field) => field.name)
    .filter((name) => !inherited.has(name) && !name.endsWith('_Valid'));

  const record = await deps.connection.transport
    .request<OdataRecord>(
      deps.connection.transport.routes.record(`${subtypeName}s`, recId),
    )
    .catch(() => undefined);
  if (record === undefined) return {};

  const body: Record<string, string> = {};
  for (const name of added) {
    const text = toText(record[name]);
    if (text !== undefined && text !== '') body[name] = text;
  }
  return body;
}

export function createSearchKnowledgeTool(deps: IvantiToolDeps): ToolDefinition {
  const enduser = deps.ownRecordsOnly;

  return defineTool({
    name: 'search_knowledge',
    title: 'Search the knowledge base',
    description:
      'Searches the knowledge base for articles — how-to guides, known errors, workarounds.\n\n' +
      'TRY THIS BEFORE RAISING A TICKET when the question sounds like something that has been ' +
      'answered before. An article that solves it is faster than a ticket that gets the same ' +
      'answer three days later.\n\n' +
      (enduser
        ? 'Only PUBLISHED articles are searched. Drafts, articles still under review and ' +
          'rejected ones are internal and are not returned.'
        : 'All states are searched, and each result says which. A Draft or Rejected article is ' +
          'internal — do not pass its content to the person who raised the ticket as though it ' +
          'were guidance.') +
      '\n\nBodies are HTML and come back as text, shortened — each result says whether it was ' +
      'cut. For the whole article pass `articleNumber` instead of `query`: the full text lives ' +
      'on a subtype that the record tools cannot reach from `FRS_Knowledge`, so this is the only ' +
      'way to read one end to end.',
    annotations: {
      title: 'Search the knowledge base',
      readOnlyHint: true,
      idempotentHint: true,
      // Article text is authored by whoever wrote it; treat it as content, not instruction.
      openWorldHint: true,
    },
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('Keywords — "vpn error 413", "reset password". Omit when passing `articleNumber`.'),
      articleNumber: z
        .number()
        .int()
        .optional()
        .describe(
          "One article's number, from a search result, returned in full instead of as an " +
            'excerpt. Ignores `query`.',
        ),
      category: z.string().optional().describe('Narrow to one category, e.g. `Network Software`.'),
      top: z
        .number()
        .int()
        .min(1)
        .max(MAX_TOP)
        .optional()
        .describe('Articles to return. Default 10.'),
      excerptChars: z
        .number()
        .int()
        .min(100)
        .max(4000)
        .optional()
        .describe(`How much of each article body to return. Default ${String(DEFAULT_EXCERPT)}.`),
    },
    handler: (args) =>
      runTool('search_knowledge', deps.logger, async () => {
        if (args.articleNumber !== undefined) {
          const oneUrl = withQuery(
            deps.connection.transport.routes.entitySet('frs_knowledges'),
            buildQuery({
              filter:
                `KnowledgeNumber eq ${String(args.articleNumber)}` +
                // The audience rule holds here too: an end user cannot read a draft by number.
                (enduser ? ` and Status eq '${PUBLISHED}'` : ''),
              top: 1,
            }),
          );
          const base = readCollection<OdataRecord>(
            await deps.connection.transport.request<OdataRecord>(oneUrl),
            oneUrl,
          )[0];

          if (base === undefined) {
            return errorResult(
              `No article numbered ${String(args.articleNumber)}` +
                (enduser ? ' is published.' : '.') +
                ' Search for it by keyword rather than guessing another number.',
            );
          }

          const body = await readWholeArticle(deps, base);
          return jsonResult({
            number: base['KnowledgeNumber'] ?? null,
            title: base['Title'] ?? null,
            ...(enduser ? {} : { status: base['Status'] ?? null }),
            category: base['Category'] ?? null,
            summary: toText(base['Details']) ?? null,
            ...(Object.keys(body).length === 0
              ? {
                  note:
                    'This article type carries nothing beyond the summary above, or its body ' +
                    'could not be read.',
                }
              : { article: body }),
          });
        }

        if (args.query === undefined || args.query === '') {
          return errorResult('Give me keywords to search for, or an `articleNumber` to read.');
        }

        const conditions: string[] = [];
        // The audience rule, applied here because the object gate cannot express "these rows".
        if (enduser) conditions.push(`Status eq '${PUBLISHED}'`);
        if (args.category !== undefined && args.category !== '') {
          conditions.push(`Category eq '${args.category.replace(/'/g, "''")}'`);
        }

        const url = withQuery(
          deps.connection.transport.routes.entitySet('frs_knowledges'),
          buildQuery({
            search: args.query,
            ...(conditions.length > 0 ? { filter: conditions.join(' and ') } : {}),
            top: args.top ?? 10,
            count: true,
          }),
        );

        const payload = await deps.connection.transport.request<OdataRecord>(url);
        const rows = readCollection<OdataRecord>(payload, url);
        const total = readTotal(payload, rows.length);
        const limit = args.excerptChars ?? DEFAULT_EXCERPT;

        const articles = rows.map((row) => {
          const body = toText(row['Details']);
          const excerpt = body === undefined ? undefined : body.slice(0, limit);
          return {
            number: row['KnowledgeNumber'] ?? null,
            title: row['Title'] ?? null,
            ...(enduser ? {} : { status: row['Status'] ?? null }),
            category: row['Category'] ?? null,
            ...(excerpt === undefined
              ? {}
              : {
                  excerpt,
                  // Always stated, never inferred from absence: a reader who cannot tell a short
                  // article from a cut one asks again with a bigger excerpt and gets the same
                  // bytes back.
                  truncated: body !== undefined && body.length > limit,
                  ...(body !== undefined && body.length > limit
                    ? { moreChars: body.length - limit }
                    : {}),
                }),
          };
        });

        return jsonResult({
          query: args.query,
          returned: articles.length,
          ...(total === undefined ? {} : { total: total.total, totalIsExact: total.exact }),
          ...(enduser ? { searched: 'published articles only' } : {}),
          articles,
        });
      }),
  });
}
