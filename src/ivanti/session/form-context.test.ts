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
