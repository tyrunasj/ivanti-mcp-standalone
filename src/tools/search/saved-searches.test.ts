import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { answersForSignedInAccount, createListSavedSearchesTool } from './list-saved-searches.js';
import { createSavedSearchTool } from './saved-search.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const FORM_CHAIN = {
  GetRoleWorkspaces: {
    Workspaces: [{ ID: 'Incident#', Name: 'Incident', LayoutName: 'L', Profile: 'ObjectWorkspace' }],
  },
  GetWorkspaceData: {
    ObjectId: 'Incident#',
    LayoutData: { newRecordViews: { 'Incident#': 'v' } },
    SearchData: {
      favorites: [
        { Id: 'f1', Name: 'All Active Incidents', isDefault: true },
        { Id: 'f2', Name: 'My Active' },
        { Id: 'f3' },
      ],
    },
  },
  FindFormViewData: {
    formDef: {
      FormMeta: { Name: 'F' },
      TableMeta: { TableRef: 'Incident#', ValidatedFields: {} },
    },
  },
};

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};
const body = (result: CallToolResult): Record<string, never> =>
  JSON.parse(text(result) || '{}') as Record<string, never>;

const deps = (responses: Record<string, unknown> = {}) => {
  const { connection, urls } = connectionFixture({
    entities: { incident: entityFixture('incident') },
    capability: { tier: 'session', identity: { role: 'Admin' } },
    sessionCalls: FORM_CHAIN,
    responses,
  });
  return { urls, deps: { connection, gate: OPEN_GATE, logger: logger() } };
};

describe('answersForSignedInAccount', () => {
  it('catches the names that resolve against whoever is signed in', () => {
    expect(answersForSignedInAccount('My Active')).toBe(true);
    expect(answersForSignedInAccount("My Team's Incidents")).toBe(true);
    expect(answersForSignedInAccount('All Active Incidents')).toBe(false);
    // "Mystery" is not "my".
    expect(answersForSignedInAccount('Mystery shopper tickets')).toBe(false);
  });
});

describe('list_saved_searches', () => {
  it('lists the tenant’s own searches and flags the ones about "me"', async () => {
    const { deps: d } = deps();

    const result = body(await createListSavedSearchesTool(d).handler({ object: 'Incidents' }));

    expect(result.searches).toEqual([
      { name: 'All Active Incidents', id: 'f1', isDefault: true },
      { name: 'My Active', id: 'f2', answersForServiceAccount: true },
    ]);
  });
});

describe('saved_search', () => {
  it('runs one and reports the total, trimming rows to a compact set', async () => {
    const { deps: d, urls } = deps({
      'All%20Active': {
        value: [{ RecId: 'a', IncidentNumber: 1, Subject: 'x', Symptom: 'long text' }],
        '@odata.count': 54,
      },
    });

    const result = body(
      await createSavedSearchTool(d).handler({
        object: 'Incidents',
        name: 'All Active',
        searchId: 'f1',
      }),
    );

    expect(result).toMatchObject({ search: 'All Active', returned: 1, total: 54 });
    // `$select` is useless here — Ivanti keeps every key and blanks the values — so the trim is
    // client-side and `Symptom` simply is not asked for.
    expect(JSON.stringify(result.rows)).not.toContain('long text');
    // URLSearchParams percent-encodes the `$`, which Ivanti accepts — verified live.
    expect(decodeURIComponent(urls[0] ?? '')).toContain('ActionId=f1');
    expect(decodeURIComponent(urls[0] ?? '')).toContain('$inlinecount=allpages');
  });

  it('treats an empty answer as a real answer', async () => {
    // A saved search matching nothing answers 204 with an empty body.
    const { deps: d } = deps({});

    const result = body(
      await createSavedSearchTool(d).handler({ object: 'Incidents', name: 'None', searchId: 'f1' }),
    );

    expect(result).toMatchObject({ returned: 0, rows: [] });
  });

  it('says whose answer a "My" search is', async () => {
    const { deps: d } = deps({ 'My%20Active': { value: [], '@odata.count': 0 } });

    const result = body(
      await createSavedSearchTool(d).handler({
        object: 'Incidents',
        name: 'My Active',
        searchId: 'f2',
      }),
    );

    expect(String(result.answeredFor)).toContain('NOT the person asking');
  });

  it('returns whole records only when asked outright', async () => {
    const { deps: d } = deps({
      'All%20Active': { value: [{ RecId: 'a', Symptom: 'long text' }] },
    });

    const result = body(
      await createSavedSearchTool(d).handler({
        object: 'Incidents',
        name: 'All Active',
        searchId: 'f1',
        fields: '*',
      }),
    );

    expect(JSON.stringify(result.rows)).toContain('long text');
  });
});
