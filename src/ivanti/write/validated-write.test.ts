import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture, field } from '../connection.fixture.js';
import type { Logger } from '../../logger.js';
import {
  confirmWrite,
  resolveValidatedWrite,
  toObjectId,
  ValidatedValueError,
  WriteNotStoredError,
} from './validated-write.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const INCIDENT = entityFixture('incident', {
  fields: [
    field('Subject'),
    field('Status', { validated: true }),
    field('Category', { validated: true }),
    field('Service'),
  ],
});

const FORM_CHAIN = {
  GetRoleWorkspaces: {
    Workspaces: [
      { ID: 'Incident#', Name: 'Incident', LayoutName: 'IncidentLayout.SD', Profile: 'ObjectWorkspace' },
    ],
  },
  GetWorkspaceData: { ObjectId: 'Incident#', LayoutData: { newRecordViews: { 'Incident#': 'v' } } },
  FindFormViewData: {
    formDef: {
      FormMeta: { Name: 'Incident.Header' },
      TableMeta: {
        TableRef: 'Incident#',
        ValidatedFields: {
          Status: { ValidatedIdFieldRef: 'Status_Valid' },
          Category: { Condition: { FieldRefs: ['(other)Ignore', 'Service'] } },
        },
      },
    },
  },
  GetFormDefaultData: { Data: { Objects: { t1: { Values: { Status: '', Service: '' } } } } },
};

const LISTS = {
  GetFormValidationListData: {
    Status: { FieldMap: { Status: 0, RecId: 1 }, Data: [['Active', 'rec-active']] },
    Category: { FieldMap: { Category: 0, RecId: 1 }, Data: [['Connectivity', 'rec-conn']] },
  },
};

const setup = (responses: Record<string, unknown> = {}) => {
  const { connection, urls } = connectionFixture({
    entities: { incident: INCIDENT },
    capability: { tier: 'session', identity: { role: 'Admin' } },
    sessionCalls: { ...FORM_CHAIN, ...LISTS },
    responses,
  });
  return { connection, urls, logger: logger() };
};

describe('toObjectId', () => {
  it('rebuilds the AdminUI id shape from the CSDL name', () => {
    // CSDL reports names lowercase and the AdminUI id is mixed case; the services are
    // case-insensitive here (verified live), so only the `#` structure has to be right.
    expect(toObjectId('incident')).toBe('incident#');
    expect(toObjectId('ci__computer')).toBe('ci#computer');
    expect(toObjectId('Incidents')).toBe('Incident#');
  });
});

describe('resolveValidatedWrite', () => {
  it('resolves nothing when no field on the write is validated anywhere', async () => {
    const { connection, logger: log } = setup();

    const resolved = await resolveValidatedWrite({
      connection,
      logger: log,
      entity: INCIDENT,
      entitySet: 'incidents',
      fields: { Subject: 'Printer jam' },
    });

    expect(resolved).toEqual({ companions: {}, values: {}, confirm: {} });
  });

  it('trusts the FORM over $metadata, which can report no validated fields at all', async () => {
    // Measured live: Task's CSDL reports none while its form declares twenty. Gating on CSDL sent
    // the value out unresolved and Ivanti answered 500.
    const csdlSaysNothing = entityFixture('incident', {
      fields: [field('Subject'), field('Status'), field('Category'), field('Service')],
    });
    const { connection, logger: log } = setup();

    const resolved = await resolveValidatedWrite({
      connection,
      logger: log,
      entity: csdlSaysNothing,
      entitySet: 'incidents',
      fields: { Status: 'Active' },
    });

    expect(resolved.companions).toEqual({ Status_Valid: 'rec-active' });
  });

  it('writes the option identifier beside the value', async () => {
    const { connection, logger: log } = setup();

    const resolved = await resolveValidatedWrite({
      connection,
      logger: log,
      entity: INCIDENT,
      entitySet: 'incidents',
      fields: { Status: 'Active' },
    });

    // The value alone can be accepted and stored as nothing; the identifier is what makes it real.
    expect(resolved.companions).toEqual({ Status_Valid: 'rec-active' });
    expect(resolved.values).toEqual({ Status: 'Active' });
    expect(resolved.confirm).toEqual({ Status: 'Active' });
  });

  it('accepts a value in the wrong case, and stores it as Ivanti spells it', async () => {
    const { connection, logger: log } = setup();

    const resolved = await resolveValidatedWrite({
      connection,
      logger: log,
      entity: INCIDENT,
      entitySet: 'incidents',
      fields: { Status: 'aCTIVE' },
    });

    expect(resolved.values).toEqual({ Status: 'Active' });
  });

  it('refuses a value that is not on the list, and says what is', async () => {
    const { connection, logger: log } = setup();

    const failure = resolveValidatedWrite({
      connection,
      logger: log,
      entity: INCIDENT,
      entitySet: 'incidents',
      fields: { Status: 'Nearly Done' },
    });

    await expect(failure).rejects.toThrow(ValidatedValueError);
    await expect(failure).rejects.toThrow(/Allowed: Active\./);
    await expect(failure).rejects.toThrow(/Nothing was written/);
  });

  it('names the cascade parent when a refused field has one', async () => {
    const { connection, logger: log } = setup();

    const failure = resolveValidatedWrite({
      connection,
      logger: log,
      entity: INCIDENT,
      entitySet: 'incidents',
      fields: { Category: 'Nonsense' },
    });

    // `(other)`-prefixed refs point into another object and are not this record's fields.
    await expect(failure).rejects.toThrow(/filtered by Service/);
    await expect(failure).rejects.toThrow(/did not set/);
  });

  it("reads the record's stored parents on an update, so a lone patch is judged fairly", async () => {
    const { connection, logger: log, urls } = setup({
      "incidents('abc')": { RecId: 'abc', Service: 'Email', Status: 'Logged' },
    });

    await resolveValidatedWrite({
      connection,
      logger: log,
      entity: INCIDENT,
      entitySet: 'incidents',
      fields: { Category: 'Connectivity' },
      recId: 'abc',
    });

    // Without this read the list comes back filtered by an EMPTY Service and a legal value is
    // refused with a "valid values" list belonging to no record.
    expect(urls.some((url) => url.includes("incidents('abc')"))).toBe(true);
  });

  it('writes as sent when the role has no form to resolve against', async () => {
    const { connection } = connectionFixture({
      entities: { incident: INCIDENT },
      capability: { tier: 'session' },
      sessionCalls: { GetRoleWorkspaces: { Workspaces: [] } },
    });

    const resolved = await resolveValidatedWrite({
      connection,
      logger: logger(),
      entity: INCIDENT,
      entitySet: 'incidents',
      fields: { Status: 'Active' },
    });

    // No identifier to write, but the field is still confirmed afterwards — this is exactly when
    // a write no-ops silently.
    expect(resolved.companions).toEqual({});
    expect(resolved.confirm).toEqual({ Status: 'Active' });
  });
});

describe('confirmWrite', () => {
  const stored = (record: Record<string, unknown>) =>
    connectionFixture({ responses: { "incidents('abc')": record } }).connection;

  it('passes when the record holds what was intended', async () => {
    await expect(
      confirmWrite(stored({ Status: 'Active', Status_Valid: 'rec-active' }), 'incidents', 'abc', {
        Status: 'Active',
      }, { Status_Valid: 'rec-active' }),
    ).resolves.toBeUndefined();
  });

  it('refuses to call a write done when the value did not take', async () => {
    const failure = confirmWrite(stored({ Status: 'Logged' }), 'incidents', 'abc', {
      Status: 'Active',
    });

    await expect(failure).rejects.toThrow(WriteNotStoredError);
    await expect(failure).rejects.toThrow(/wrote 'Active', stored 'Logged'/);
  });

  it('catches a right-looking value over the wrong identifier', async () => {
    const failure = confirmWrite(
      stored({ Status: 'Active', Status_Valid: 'rec-of-another-object' }),
      'incidents',
      'abc',
      { Status: 'Active' },
      { Status_Valid: 'rec-active' },
    );

    await expect(failure).rejects.toThrow(/identifier 'rec-active' expected/);
  });

  it('does not treat a companion the record never echoes as wrong', async () => {
    await expect(
      confirmWrite(stored({ Status: 'Active' }), 'incidents', 'abc', { Status: 'Active' }, {
        Status_Valid: 'rec-active',
      }),
    ).resolves.toBeUndefined();
  });

  it('checks nothing when there was nothing validated to check', async () => {
    await expect(confirmWrite(stored({}), 'incidents', 'abc', {})).resolves.toBeUndefined();
  });
});
