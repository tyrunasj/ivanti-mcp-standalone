// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { buildQuery, MAX_TOP, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import type { IvantiTransport } from '../../ivanti/http/transport.js';
import { transportFor } from '../shared/transport-for.js';

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
  // Passed in rather than reached for: this runs per row inside the handler, and the credential
  // it must use is the caller's, not the service account's.
  transport: IvantiTransport,
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

  const record = await transport
    .request<OdataRecord>(transport.routes.record(`${subtypeName}s`, recId))
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
        ? 'Only PUBLISHED articles are searched; drafts and articles under review are not ' +
          'returned. PUBLISHED DOES NOT MEAN WRITTEN FOR A CUSTOMER — many are agent ' +
          'runbooks. Summarise the steps that apply to the person and do not read out ' +
          'internal queue names or referenced ticket numbers.'
        : 'All states are searched, and each result says which. A Draft or Rejected article is ' +
          'internal — do not pass its content to the person who raised the ticket as though it ' +
          'were guidance.') +
      '\n\nEVERY SEARCH RESULT IS THE SUMMARY ONLY, never the fix. `excerpt` comes from the ' +
      "article's summary field and is marked `summaryOnly: true`; `truncated` describes that " +
      'field alone, so `truncated: false` does NOT mean you have the whole article — the ' +
      'resolution steps live on a subtype and are not in the search result at all. ALWAYS pass ' +
      '`articleNumber` before telling anyone what an article says or that it lacks an answer.',
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
        .describe(
          'ONE distinctive keyword to start — `vpn`, `password`. REQUIRED unless you pass ' +
            '`articleNumber`: a call with neither is always refused, and this schema cannot ' +
            'say so structurally. WORDS ARE ANDed and match from their START, so a second word ' +
            'narrows hard — measured, `password reset` returns 0 while `password` returns 6, ' +
            'one of them about resetting a password. Start with one word; add a second only to ' +
            'narrow a list that is too long.',
        ),
      articleNumber: z
        .number()
        .int()
        .optional()
        .describe(
          "One article's number, from a search result, returned in full instead of as an " +
            'excerpt. Ignores `query`.',
        ),
      category: z.string().optional().describe('Narrow to one category, e.g. `Network Software`.'),
      ...(enduser
        ? {}
        : {
            status: z
              .string()
              .optional()
              .describe(
                'Narrow to one publication state. Pass `Published` when you want guidance to ' +
                  'act on or to hand to someone — every other state is internal and unfinished. ' +
                  'The form lists Draft, In Review, Pending Approval, Reviewed, Published, ' +
                  'Expired, Archived and Rejected, but articles on this tenant also hold states ' +
                  'the form does not offer (`Submitted`), so treat that list as the common ' +
                  'cases and not as the complete set.',
              ),
          }),
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
    handler: (args, context) =>
      runTool('search_knowledge', deps.logger, async () => {
        const transport = transportFor(deps.connection.transport, context);
        if (args.articleNumber !== undefined) {
          const oneUrl = withQuery(
            transport.routes.entitySet('frs_knowledges'),
            buildQuery({
              filter:
                `KnowledgeNumber eq ${String(args.articleNumber)}` +
                // The audience rule holds here too: an end user cannot read a draft by number.
                (enduser ? ` and Status eq '${PUBLISHED}'` : ''),
              top: 1,
            }),
          );
          const base = readCollection<OdataRecord>(
            await transport.request<OdataRecord>(oneUrl),
            oneUrl,
          )[0];

          if (base === undefined) {
            return errorResult(
              `No article numbered ${String(args.articleNumber)}` +
                (enduser ? ' is published.' : '.') +
                ' Search for it by keyword rather than guessing another number.',
            );
          }

          const body = await readWholeArticle(deps, transport, base);
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
        const status = enduser ? undefined : (args as { status?: string }).status;
        if (status !== undefined && status !== '') {
          conditions.push(`Status eq '${status.replace(/'/g, "''")}'`);
        }

        const url = withQuery(
          transport.routes.entitySet('frs_knowledges'),
          buildQuery({
            search: args.query,
            ...(conditions.length > 0 ? { filter: conditions.join(' and ') } : {}),
            top: args.top ?? 10,
            count: true,
          }),
        );

        const payload = await transport.request<OdataRecord>(url);
        const rows = readCollection<OdataRecord>(payload, url);
        const total = readTotal(payload, rows.length);
        const limit = args.excerptChars ?? DEFAULT_EXCERPT;

        /**
         * Published first, then the rest in Ivanti's own order.
         *
         * Ivanti ranks by its own relevance and has no opinion about publication state, so a
         * Draft routinely came back above the Published article on the same subject. In `full`
         * mode every state is searched deliberately — an analyst may want the draft — but the
         * finished article is the one that should be read first, and a reader skimming the top
         * result should not be skimming an unreviewed one. A stable partition, not a re-rank:
         * relative order inside each group is untouched.
         */
        const ranked =
          enduser || status !== undefined
            ? rows
            : [
                ...rows.filter((row) => row['Status'] === PUBLISHED),
                ...rows.filter((row) => row['Status'] !== PUBLISHED),
              ];

        const articles = ranked.map((row) => {
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
                  /**
                   * `truncated` describes THIS FIELD, and this field is not the article.
                   *
                   * `Details` is the summary. The fix — an IssueResolution's `Resolution`, a
                   * Document's body — lives on the subtype and is not searched or excerpted here
                   * at all. So a short summary reported `truncated: false`, which asserts nothing
                   * was cut, while the entire answer was missing. A tester nearly told an end
                   * user the VPN article contained no fix; they found the four steps on a hunch.
                   */
                  summaryOnly: true,
                }),
          };
        });

        return jsonResult({
          query: args.query,
          returned: articles.length,
          /**
           * The zero-hit note its two sibling search tools have and this one did not.
           *
           * `search` and `fulltext_search_object` both explain an empty answer in the payload;
           * this returned a bare `articles: []`. With the AND rule undocumented and the worked
           * example itself returning nothing, a tester reported "there are no knowledge articles
           * about password resets" about a base holding six.
           */
          ...(articles.length === 0 && args.articleNumber === undefined
            ? {
                note:
                  'ZERO ARTICLES IS A WEAK ANSWER, not a fact about the knowledge base. Words ' +
                  'are ANDed and match from their START — measured, `password reset` returns 0 ' +
                  'while `password` returns 6. DROP TO ONE WORD and search again before saying ' +
                  'nothing exists.' +
                  (enduser
                    ? ' Only published articles are searched here, so an unpublished one ' +
                      'answers zero too.'
                    : ''),
              }
            : {}),
          ...(total === undefined ? {} : { total: total.total, totalIsExact: total.exact }),
          ...(enduser ? { searched: 'published articles only' } : {}),
          ...(enduser || status !== undefined
            ? {}
            : {
                ordering:
                  'Published articles first, then every other state in Ivanti’s own relevance ' +
                  'order. A result whose `status` is not Published is internal and unfinished — ' +
                  'do not hand its content to the person who raised the ticket as guidance. Pass ' +
                  "`status: 'Published'` to search only finished articles.",
              }),
          articles,
        });
      }),
  });
}
