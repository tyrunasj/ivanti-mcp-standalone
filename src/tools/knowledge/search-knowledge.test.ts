// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture, field } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { createSearchKnowledgeTool } from './search-knowledge.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};
const body = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(text(result) || '{}') as Record<string, unknown>;

const ENTITIES = {
  frs_knowledge: { fields: [field('RecId'), field('Title'), field('Details'), field('Status')] },
  frs_knowledge__issueresolution: {
    fields: [field('RecId'), field('Title'), field('Details'), field('Status'), field('Resolution'), field('Resolution_Valid')],
  },
};

function tool(responses: Record<string, unknown>, enduser: boolean) {
  const { connection, urls } = connectionFixture({
    entities: Object.fromEntries(
      Object.entries(ENTITIES).map(([name, over]) => [name, entityFixture(name, over)]),
    ),
    responses,
  });
  return {
    urls,
    search: createSearchKnowledgeTool({
      connection,
      gate: OPEN_GATE,
      logger: logger(),
      ownRecordsOnly: enduser,
      actions: OPEN_ACTIONS,
    }),
  };
}

const ARTICLE = {
  RecId: 'K1',
  KnowledgeNumber: 7,
  Title: 'VPN',
  Status: 'Published',
  Category: 'Network',
  FRS_KnowledgeType: 'IssueResolution',
  Details: '<p>Short <b>summary</b>&nbsp;here</p>',
};

describe('search_knowledge by article number', () => {
  it('asks only for Published articles when the audience is an end user', async () => {
    const { search, urls } = tool({ frs_knowledges: { value: [ARTICLE] } }, true);

    await search.handler({ articleNumber: 7 });

    const url = decodeURIComponent(urls[0] ?? '');
    expect(url).toContain("KnowledgeNumber eq 7 and Status eq 'Published'");
  });

  it('does not add the Published clause for IT staff', async () => {
    const { search, urls } = tool({ frs_knowledges: { value: [ARTICLE] } }, false);

    await search.handler({ articleNumber: 7 });

    const url = decodeURIComponent(urls[0] ?? '');
    expect(url).toContain('KnowledgeNumber eq 7');
    expect(url).not.toContain('Published');
  });

  it('refuses an unpublished article to an end user as "not published"', async () => {
    const { search } = tool({ frs_knowledges: { value: [] } }, true);

    const result = await search.handler({ articleNumber: 99 });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('is published');
  });

  it('reads the body off the subtype, stripping HTML, and hides status from an end user', async () => {
    const { search, urls } = tool(
      {
        frs_knowledges: { value: [ARTICLE] },
        frs_knowledge__issueresolutions: { RecId: 'K1', Resolution: '<ol><li>Reboot</li><li>Retry</li></ol>' },
      },
      true,
    );

    const result = body(await search.handler({ articleNumber: 7 }));

    expect(result['summary']).toBe('Short summary here');
    expect(result['article']).toEqual({ Resolution: 'Reboot\nRetry' });
    expect(result).not.toHaveProperty('status');
    expect(urls.some((url) => url.includes("frs_knowledge__issueresolutions('K1')"))).toBe(true);
  });

  it('shows the status to IT staff and says so when the subtype adds nothing', async () => {
    const { search } = tool({ frs_knowledges: { value: [{ ...ARTICLE, FRS_KnowledgeType: '' }] } }, false);

    const result = body(await search.handler({ articleNumber: 7 }));

    expect(result['status']).toBe('Published');
    expect(String(result['note'])).toContain('nothing beyond the summary');
  });
});

describe('search_knowledge by keyword', () => {
  it('refuses a call with neither keywords nor a number', async () => {
    const { search } = tool({}, false);

    expect((await search.handler({})).isError).toBe(true);
  });

  it('adds the Published clause and hides status for an end user', async () => {
    const { search, urls } = tool({ frs_knowledges: { value: [ARTICLE], '@odata.count': 1 } }, true);

    const result = body(await search.handler({ query: 'vpn' }));

    expect(decodeURIComponent(urls[0] ?? '')).toContain("Status eq 'Published'");
    expect(result['searched']).toBe('published articles only');
    expect((result['articles'] as Array<Record<string, unknown>>)[0]).not.toHaveProperty('status');
  });

  it('searches every state for IT staff and lists Published first', async () => {
    const draft = { ...ARTICLE, KnowledgeNumber: 1, Status: 'Draft' };
    const { search, urls } = tool({ frs_knowledges: { value: [draft, ARTICLE] } }, false);

    const result = body(await search.handler({ query: 'vpn', category: "O'Neil" }));

    const url = decodeURIComponent(urls[0] ?? '');
    expect(url).not.toContain("Status eq 'Published'");
    expect(url).toContain("Category eq 'O''Neil'");
    expect((result['articles'] as Array<Record<string, unknown>>).map((a) => a['number'])).toEqual([7, 1]);
    expect(result).toHaveProperty('ordering');
  });

  it('narrows to a status for IT staff and cuts the excerpt, saying so', async () => {
    const long = { ...ARTICLE, Details: `<p>${'x'.repeat(300)}</p>` };
    const { search, urls } = tool({ frs_knowledges: { value: [long] } }, false);

    const result = body(await search.handler({ query: 'vpn', status: 'Draft', excerptChars: 100 }));

    expect(decodeURIComponent(urls[0] ?? '')).toContain("Status eq 'Draft'");
    const [first] = result['articles'] as Array<Record<string, unknown>>;
    expect(first).toMatchObject({ truncated: true, moreChars: 200, summaryOnly: true });
  });

  it('explains an empty answer as weak', async () => {
    const { search } = tool({ frs_knowledges: { value: [] } }, true);

    const result = body(await search.handler({ query: 'password reset' }));

    expect(String(result['note'])).toContain('ZERO ARTICLES IS A WEAK ANSWER');
    expect(String(result['note'])).toContain('published');
  });
});
