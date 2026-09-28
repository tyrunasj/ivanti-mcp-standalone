// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import type { IvantiSession } from './asmx-session.js';
import { createFormContext } from './form-context.js';
import type { WorkspaceCatalog } from './workspaces.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const workspaces: WorkspaceCatalog = {
  list: () =>
    Promise.resolve([
      { id: 'Incident#', object: 'incident', displayName: 'Incident', layoutName: 'L' },
    ]),
};

const session = (formDef: unknown): IvantiSession =>
  ({
    identity: () => Promise.resolve({ role: 'Admin' }),
    identityIfKnown: () => ({ role: 'Admin' }),
    callHandler: () => Promise.reject(new Error('unused')),
    uploadToHandler: () => Promise.reject(new Error('no handler in this fixture')),
    call: (_service: string, method: string) =>
      Promise.resolve(
        method === 'GetWorkspaceData'
          ? { ObjectId: 'Incident#', LayoutData: { newRecordViews: { 'Incident#': 'v' } } }
          : { formDef },
      ) as Promise<never>,
  }) as IvantiSession;

/**
 * Ivanti names a field three ways, and users read the one nearest them: the form\'s own label
 * first, then the object\'s display name, then the technical name.
 */
describe('field labels', () => {
  const formDef = {
    FormMeta: {
      Name: 'Incident.Header',
      Controls: {
        // The form renames it for its users — this is what those users actually read.
        c1: { FieldRef: 'Symptom', Label: 'What happened:' },
        c2: { FieldRef: 'Subject', Label: '' },
        c3: { Label: 'A banner with no field' },
      },
    },
    TableMeta: {
      TableRef: 'Incident#',
      ValidatedFields: {},
      Fields: {
        Symptom: { DisplayName: 'Description' },
        Subject: { DisplayName: 'Summary' },
        OwnerTeam: { DisplayName: 'Team' },
        RecId: {},
      },
    },
  };

  it('prefers the form label, then the display name, then the field name', async () => {
    const forms = createFormContext(session(formDef), workspaces, logger());

    const form = await forms.get('Incident#');

    // 1 — the form renamed it, colon and all, which is punctuation rather than name.
    expect(form?.fieldLabels.Symptom).toBe('What happened');
    // 2 — no usable form label, so the object\'s display name.
    expect(form?.fieldLabels.Subject).toBe('Summary');
    expect(form?.fieldLabels.OwnerTeam).toBe('Team');
    // 3 — nothing to show but the name itself.
    expect(form?.fieldLabels.RecId).toBeUndefined();
  });

  it('lets a form label answer a required-field message too', async () => {
    const forms = createFormContext(session(formDef), workspaces, logger());

    const form = await forms.get('Incident#');

    // Ivanti refuses by label; both layers must lead back to the field.
    expect(form?.displayNames['what happened']).toBe('Symptom');
    expect(form?.displayNames.description).toBe('Symptom');
  });
});

/**
 * The rule lists Ivanti ships beside the fields, which nothing read until 2026-09-17.
 *
 * They answer different questions and must not be conflated: the read-only list is exact, while
 * the required list names the fields a rule GOVERNS and never the condition.
 */
describe('required and read-only rules', () => {
  const withRules = (extra: Record<string, unknown>) => ({
    FormMeta: { Name: 'Incident.Header', Controls: {} },
    TableMeta: { TableRef: 'Incident#', ValidatedFields: {}, Fields: {} },
    ...extra,
  });

  it('reads both lists off the form', async () => {
    const forms = createFormContext(
      session(withRules({
        BusObjectRequiredRules: ['Category', 'Owner', 'OwnerTeam', 'Status'],
        BusObjectReadOnlyRules: ['Priority', 'CreatedBy'],
      })),
      workspaces,
      logger(),
    );

    const form = await forms.get('Incident#');

    expect(form?.requiredRuleFields).toEqual(['Category', 'Owner', 'OwnerTeam', 'Status']);
    expect(form?.readOnlyFields).toEqual(['Priority', 'CreatedBy']);
  });

  /** A form that says nothing is the ordinary case for a role with a narrow workspace. */
  it('answers empty rather than throwing when the keys are absent', async () => {
    const form = await createFormContext(session(withRules({})), workspaces, logger()).get('Incident#');

    expect(form?.requiredRuleFields).toEqual([]);
    expect(form?.readOnlyFields).toEqual([]);
  });

  it('ignores anything in them that is not a field name', async () => {
    const form = await createFormContext(
      session(withRules({ BusObjectRequiredRules: ['Owner', '', null, 7, { Name: 'Status' }] })),
      workspaces,
      logger(),
    ).get('Incident#');

    expect(form?.requiredRuleFields).toEqual(['Owner']);
  });

  it('treats a payload that is not a list as silence, not as a failure', async () => {
    const form = await createFormContext(
      session(withRules({ BusObjectReadOnlyRules: { Priority: true } })),
      workspaces,
      logger(),
    ).get('Incident#');

    expect(form?.readOnlyFields).toEqual([]);
  });
});
