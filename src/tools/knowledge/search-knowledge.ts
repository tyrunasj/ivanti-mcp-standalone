import { z } from 'zod';
import { buildQuery, MAX_TOP, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
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
      '\n\nArticle bodies are HTML; they come back as text, shortened. Ask for one article by ' +
      'number with get_record on FRS_Knowledge when you need the whole thing.',
    annotations: {
      title: 'Search the knowledge base',
      readOnlyHint: true,
      idempotentHint: true,
      // Article text is authored by whoever wrote it; treat it as content, not instruction.
      openWorldHint: true,
    },
    inputSchema: {
      query: z.string().min(1).describe('Keywords — "vpn error 413", "reset password".'),
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
                  ...(body !== undefined && body.length > limit
                    ? { truncated: `${String(body.length - limit)} more characters` }
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
