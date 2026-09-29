// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture, field } from '../connection.fixture.js';
import type { Logger } from '../../logger.js';
import { formFixture } from '../session/form.fixture.js';
import {
  confirmWrite,
  readBackReport,
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

  // `status` skipped resolution entirely while `Status` was resolved: the form and CSDL were both
  // looked up by exact name, and a bogus value then went out unchecked.
  it('resolves a validated field whatever case it was written in', async () => {
    const { connection, logger: log } = setup();

    const refused = resolveValidatedWrite({
      connection,
      logger: log,
      entity: INCIDENT,
      entitySet: 'incidents',
      fields: { status: 'Bogus' },
    });
    const resolved = await resolveValidatedWrite({
      connection,
      logger: log,
      entity: INCIDENT,
      entitySet: 'incidents',
      fields: { status: 'active' },
    });

    await expect(refused).rejects.toThrow(ValidatedValueError);
    expect(resolved.companions).toEqual({ Status_Valid: 'rec-active' });
    expect(resolved.confirm).toEqual({ status: 'Active' });
  });
});

describe('confirmWrite', () => {
  const stored = (record: Record<string, unknown> | undefined) =>
    connectionFixture({ responses: record === undefined ? {} : { "incidents('abc')": record } });

  /** What `resolveValidatedWrite` hands over. `values` holds what it resolved against a live list. */
  const resolved = (
    confirm: Record<string, unknown> = {},
    companions: Record<string, unknown> = {},
    values: Record<string, unknown> = confirm,
  ) => ({ confirm, companions, values });

  const confirmOn = (
    record: Record<string, unknown> | undefined,
    options: Partial<Parameters<typeof confirmWrite>[0]> = {},
  ) =>
    confirmWrite({
      connection: stored(record).connection,
      entitySet: 'incidents',
      recId: 'abc',
      resolved: resolved(),
      ...options,
    });

  it('passes when the record holds what was intended', async () => {
    await expect(
      confirmOn(
        { Status: 'Active', Status_Valid: 'rec-active' },
        { resolved: resolved({ Status: 'Active' }, { Status_Valid: 'rec-active' }) },
      ),
    ).resolves.toMatchObject({ ignoredByIvanti: {}, notConfirmed: [] });
  });

  it('refuses to call a write done when the value did not take', async () => {
    const failure = confirmOn({ Status: 'Logged' }, { resolved: resolved({ Status: 'Active' }) });

    await expect(failure).rejects.toThrow(WriteNotStoredError);
    await expect(failure).rejects.toThrow(/wrote 'Active', stored 'Logged'/);
  });

  it('catches a right-looking value over the wrong identifier', async () => {
    const failure = confirmOn(
      { Status: 'Active', Status_Valid: 'rec-of-another-object' },
      { resolved: resolved({ Status: 'Active' }, { Status_Valid: 'rec-active' }) },
    );

    await expect(failure).rejects.toThrow(/identifier 'rec-active' expected/);
  });

  it('does not treat a companion the record never echoes as wrong', async () => {
    await expect(
      confirmOn(
        { Status: 'Active' },
        { resolved: resolved({ Status: 'Active' }, { Status_Valid: 'rec-active' }) },
      ),
    ).resolves.toMatchObject({ notConfirmed: [] });
  });

  it('reads nothing when nothing was written', async () => {
    const { connection, urls } = stored({});

    await expect(
      confirmWrite({ connection, entitySet: 'incidents', recId: 'abc', resolved: resolved() }),
    ).resolves.toEqual({ ignoredByIvanti: {}, notConfirmed: [] });
    expect(urls).toHaveLength(0);
  });

  describe('a free field', () => {
    // The descriptions promise a write Ivanti accepted but did not store is reported, and Ivanti
    // drops a free field as readily as a listed one. Only the validated ones used to be read back.
    it('is read back, and one that did not take fails the write', async () => {
      const failure = confirmOn({ Subject: 'Old subject' }, { written: { Subject: 'New subject' } });

      await expect(failure).rejects.toThrow(WriteNotStoredError);
      await expect(failure).rejects.toThrow(/Subject: wrote 'New subject', stored 'Old subject'/);
      await expect(failure).rejects.toThrow(/not from a list, so the value was legal/);
      await expect(failure).rejects.toThrow(/do not repeat the whole write/);
    });

    it('fails when a value meant to clear it did not', async () => {
      await expect(confirmOn({ Owner: 'HSanders' }, { written: { Owner: null } })).rejects.toThrow(
        /Owner: wrote '', stored 'HSanders'/,
      );
    });

    // Each of these TOOK — it is only stored in Ivanti's own rendering.
    it.each([
      ['a zoned date, stored in UTC', 'Edm.DateTimeOffset', '2026-10-01T12:00:00+02:00', '2026-10-01T10:00:00Z'],
      ['a date that lost its milliseconds', 'Edm.DateTimeOffset', '2026-10-01T10:00:00.400Z', '2026-10-01T10:00:00Z'],
      ['a zone-less time, read in the tenant zone', 'Edm.DateTimeOffset', '2026-10-01T12:00:00', '2026-10-01T10:00:00Z'],
      ['a date alone, stored at local midnight', 'Edm.DateTimeOffset', '2026-10-01', '2026-09-30T22:00:00Z'],
      ['a number sent as text', 'Edm.Int32', '5', 5],
      ['a decimal with trailing zeros', 'Edm.Decimal', 2.5, '2.50'],
      ['a flag sent as text', 'Edm.Boolean', 'true', true],
      ['false, which a nullable flag keeps as null', 'Edm.Boolean', false, null],
      ['text with its whitespace and case moved', 'Edm.String', 'Printer  jam\r\non floor 2 ', 'printer jam\non floor 2'],
    ])('passes %s', async (_label, type, wrote, holds) => {
      const entity = entityFixture('incident', { fields: [field('Due', { type })] });

      await expect(
        confirmOn({ Due: holds }, { written: { Due: wrote }, entity }),
      ).resolves.toMatchObject({ notConfirmed: [] });
    });

    it.each([
      ['a date a day out', 'Edm.DateTimeOffset', '2026-10-01T10:00:00Z', '2026-10-02T10:00:00Z'],
      ['a zone-less date that stayed on the old day', 'Edm.DateTimeOffset', '2026-10-01', '2026-09-20T00:00:00Z'],
      ['a different number', 'Edm.Int32', 5, 4],
      ['a flag that stayed off', 'Edm.Boolean', true, false],
      ['text cut short', 'Edm.String', 'Printer jam on floor 2', 'Printer jam on fl'],
    ])('fails %s', async (_label, type, wrote, holds) => {
      const entity = entityFixture('incident', { fields: [field('Due', { type })] });

      await expect(confirmOn({ Due: holds }, { written: { Due: wrote }, entity })).rejects.toThrow(
        WriteNotStoredError,
      );
    });

    // Measured: `LastModBy` is re-stamped by the engine even when sent. Reported, never a failure.
    it('reports a field Ivanti stamps itself as ignored, not as a failure', async () => {
      const readBack = await confirmOn(
        { Subject: 'x', LastModBy: 'svc-account' },
        { written: { Subject: 'x', LastModBy: 'jdoe' } },
      );

      expect(readBack.ignoredByIvanti).toEqual({ LastModBy: 'svc-account' });
      expect(readBackReport(readBack)).toMatchObject({ ignoredByIvanti: { LastModBy: 'svc-account' } });
    });

    it('does not compare rich text, and says so rather than failing it', async () => {
      const readBack = await confirmOn(
        { Resolution: '<p>Rebooted the <b>printer</b></p>' },
        { written: { Resolution: 'Rebooted the printer' } },
      );

      expect(readBack.notConfirmed).toEqual([expect.stringContaining('Resolution — rich text')]);
    });

    it('still fails rich text that stored as nothing at all', async () => {
      await expect(
        confirmOn({ Resolution: null }, { written: { Resolution: '<p>Rebooted</p>' } }),
      ).rejects.toThrow(WriteNotStoredError);
    });

    it('does not compare a structured value', async () => {
      const readBack = await confirmOn({ Blob: 'x' }, { written: { Blob: { nested: true } } });

      expect(readBack.notConfirmed).toEqual(['Blob — a structured value, which is not compared']);
    });

    it('says which fields it could not see, rather than passing them silently', async () => {
      const notReturned = await confirmOn({ Subject: 'x' }, { written: { Subject: 'x', Hidden: 'y' } });
      const unreadable = await confirmOn(undefined, { written: { Subject: 'x' } });

      expect(notReturned.notConfirmed).toEqual(['Hidden — the read-back does not return this field']);
      expect(unreadable.notConfirmed).toEqual(['Subject — the record could not be read back']);
      expect(readBackReport(unreadable)).toEqual({ notConfirmed: unreadable.notConfirmed });
    });

    it('matches the stored field whatever case the write used', async () => {
      await expect(confirmOn({ Subject: 'Old' }, { written: { subject: 'New' } })).rejects.toThrow(
        /subject: wrote 'New', stored 'Old'/,
      );
    });

    it('returns the record it read, so a tool can show what stored', async () => {
      const readBack = await confirmOn({ RecId: 'abc', Subject: 'x' }, { written: { Subject: 'x' } });

      expect(readBack.stored).toEqual({ RecId: 'abc', Subject: 'x' });
      expect(readBackReport(readBack)).toEqual({});
    });
  });

  /**
   * The advice used to be one sentence — "a stale option list" — for every kind of failure, and it
   * is wrong for most of them. Measured: an incident's Priority is on the picklist and computed
   * from Urgency × Impact, so a legal value from a fresh list is overwritten, and refreshing the
   * list sends the caller round the same failure again.
   */
  describe('what it tells the caller to do', () => {
    const form = formFixture({
      validatedFields: { Priority: {}, Urgency: {}, Impact: {} },
      readOnlyFields: ['Priority'],
    });

    it('calls a field under a read-only rule computed, and names the likely inputs', async () => {
      const failure = confirmOn(
        { Priority: '1', Urgency: 'High', Impact: 'High' },
        { resolved: resolved({ Priority: '2', Urgency: 'High', Impact: 'High' }), form },
      );

      await expect(failure).rejects.toThrow(/Priority is governed by a read-only rule/);
      await expect(failure).rejects.toThrow(/COMPUTES/);
      await expect(failure).rejects.toThrow(/this write also set Urgency, Impact/);
      await expect(failure).rejects.not.toThrow(/stale option list/);
    });

    it('does not call a list stale that was read for this very write', async () => {
      const failure = confirmOn({ Urgency: 'Low' }, { resolved: resolved({ Urgency: 'High' }), form });

      await expect(failure).rejects.toThrow(/was on the option list read for this write/);
      await expect(failure).rejects.not.toThrow(/usually a stale option list/);
    });

    it('keeps the stale-list advice where no list was read', async () => {
      // No form: the value went out as sent, and nothing checked it against a list.
      const failure = confirmOn({ Status: 'Logged' }, { resolved: resolved({ Status: 'Active' }, {}, {}) });

      await expect(failure).rejects.toThrow(/usually a stale option list/);
    });
  });
});
