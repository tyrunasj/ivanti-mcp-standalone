import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import type { IvantiSession } from './asmx-session.js';
import { createFormContext } from './form-context.js';
import { readPickLists } from './pick-lists.js';
import type { WorkspaceCatalog } from './workspaces.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const FORM = {
  formDef: {
    FormMeta: { Name: 'Incident.Admin.Header' },
    TableMeta: {
      TableRef: 'Incident#',
      ValidatedFields: { Status: { ValidatorRef: 'v1' }, Category: { ValidatorRef: 'v2' } },
    },
  },
};

const WORKSPACE_DATA = {
  ObjectId: 'Incident#',
  LayoutData: { newRecordViews: { 'Incident#': 'formView' } },
};

const DEFAULTS = { Data: { Objects: { 'tmp-1': { Values: { Status: '', Service: '' } } } } };

const LISTS = {
  Status: {
    FieldMap: { Status: 0, RecId: 1 },
    Data: [
      ['Active', 'rec-active'],
      ['Closed', 'rec-closed'],
    ],
  },
  Category: { FieldMap: {}, Data: [], SameAs: 'ActualCategory' },
  ActualCategory: { FieldMap: { ActualCategory: 0 }, Data: [['Connectivity']] },
};

function session(answers: Record<string, unknown>): {
  session: IvantiSession;
  calls: { method: string; args: Record<string, unknown> }[];
} {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    session: {
      identity: () => Promise.resolve({ role: 'Admin' }),
      identityIfKnown: () => ({ role: 'Admin' }),
      callHandler: () => Promise.reject(new Error('unused')),
      call: (_service: string, method: string, args: Record<string, unknown> = {}) => {
        calls.push({ method, args });
        const answer = answers[method];
        if (answer === undefined) return Promise.reject(new Error(`no stub for ${method}`));
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(answer) as Promise<never>;
      },
    },
  };
}

const workspaces = (entries: { id: string; layoutName: string }[]): WorkspaceCatalog => ({
  list: () =>
    Promise.resolve(
      entries.map((entry) => ({ ...entry, object: entry.id.replace('#', '').toLowerCase(), displayName: entry.id })),
    ),
});

const INCIDENT_WORKSPACE = workspaces([{ id: 'Incident#', layoutName: 'IncidentLayout.SD' }]);

describe('createFormContext', () => {
  it('walks workspace → layout → view → form, once', async () => {
    const { session: live, calls } = session({
      GetWorkspaceData: WORKSPACE_DATA,
      FindFormViewData: FORM,
    });
    const forms = createFormContext(live, INCIDENT_WORKSPACE, logger());

    const first = await forms.get('Incident#');
    await forms.get('Incidents');

    expect(first).toEqual({
      layoutName: 'IncidentLayout.SD',
      viewName: 'formView',
      formName: 'Incident.Admin.Header',
      validatedFields: FORM.formDef.TableMeta.ValidatedFields,
    });
    // Three calls would be two walks; the answer cannot change while the server runs.
    expect(calls.filter((call) => call.method === 'FindFormViewData')).toHaveLength(1);
  });

  it('refuses a form that describes another object', async () => {
    // Ivanti resolves the form from the LAYOUT, so the wrong one still answers 200.
    const { session: live } = session({
      GetWorkspaceData: WORKSPACE_DATA,
      FindFormViewData: {
        formDef: { FormMeta: { Name: 'Task.Form' }, TableMeta: { TableRef: 'Task#', ValidatedFields: {} } },
      },
    });

    await expect(
      createFormContext(live, INCIDENT_WORKSPACE, logger()).get('Incident#'),
    ).resolves.toBeUndefined();
  });

  it('has no form for an object the role has no workspace for', async () => {
    const { session: live, calls } = session({});

    await expect(
      createFormContext(live, workspaces([]), logger()).get('Employee#'),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('readPickLists', () => {
  const form = {
    layoutName: 'IncidentLayout.SD',
    viewName: 'formView',
    formName: 'Incident.Admin.Header',
    validatedFields: FORM.formDef.TableMeta.ValidatedFields,
  };

  it('decodes columns into values, taking the lowest index as the value', async () => {
    const { session: live } = session({
      GetFormDefaultData: DEFAULTS,
      GetFormValidationListData: LISTS,
    });

    const { lists } = await readPickLists({
      session: live,
      form,
      objectId: 'Incident#',
      fields: ['Status'],
    });

    expect(lists.Status).toEqual({
      validated: true,
      values: [
        { value: 'Active', label: 'Active', recId: 'rec-active' },
        { value: 'Closed', label: 'Closed', recId: 'rec-closed' },
      ],
    });
  });

  it('follows SameAs — Category mirrors ActualCategory', async () => {
    const { session: live } = session({
      GetFormDefaultData: DEFAULTS,
      GetFormValidationListData: LISTS,
    });

    const { lists } = await readPickLists({
      session: live,
      form,
      objectId: 'Incident#',
      fields: ['Category'],
    });

    expect(lists.Category).toMatchObject({
      sameAs: 'ActualCategory',
      values: [{ value: 'Connectivity' }],
    });
  });

  it('marks a field that is not validated rather than asking Ivanti about it', async () => {
    const { session: live, calls } = session({});

    const { lists } = await readPickLists({
      session: live,
      form,
      objectId: 'Incident#',
      fields: ['Subject'],
    });

    expect(lists.Subject).toEqual({ validated: false, values: [] });
    expect(calls).toEqual([]);
  });

  it('applies a parent value, and reports one the form does not have', async () => {
    const { session: live, calls } = session({
      GetFormDefaultData: { Data: { Objects: { 'tmp-1': { Values: { Service: '' } } } } },
      GetFormValidationListData: LISTS,
    });

    const { lists, ignoredValues } = await readPickLists({
      session: live,
      form,
      objectId: 'Incident#',
      fields: ['Status'],
      values: { Service: 'Email', Nonsense: 'x' },
    });

    // The wrong key silently filtering nothing is the failure this reports.
    expect(ignoredValues).toEqual(['Nonsense']);
    expect(lists.Status?.filteredBy).toEqual({ Service: 'Email' });
    const sent = calls.find((call) => call.method === 'GetFormValidationListData');
    expect(JSON.stringify(sent?.args)).toContain('Email');
  });

  it('fails loudly when Ivanti returns no data model', async () => {
    const { session: live } = session({ GetFormDefaultData: { Data: { Objects: {} } } });

    await expect(
      readPickLists({ session: live, form, objectId: 'Incident#', fields: ['Status'] }),
    ).rejects.toThrow(/no form data model/);
  });
});
