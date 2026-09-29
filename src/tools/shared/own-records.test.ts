// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from './object-gate.js';
import { OPEN_ACTIONS } from './action-gate.js';
import type { Logger } from '../../logger.js';
import {
  NotYourRecordError,
  UnscopableObjectError,
  assertOwnRecord,
  assertOwnRecordById,
  assertRecordWritable,
  hideMissingRecord,
  missingRecordMessage,
  ownershipFields,
  scopeToOwnRecords,
} from './own-records.js';
import { IdentityRequiredError } from '../../auth/identity-pin.js';
import { IvantiApiError } from '../../ivanti/http/errors.js';
import { UnsupportedFilterError } from '../../ivanti/odata/filter.js';
import { resolveObject } from './resolve-object.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { ANONYMOUS } from '../../auth/identity.js';
import type { CallContext } from '../tool-definition.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const PERSON = {
  recId: 'E1',
  category: 'employee',
  displayName: 'Harold Sanders',
  loginId: 'HSanders',
  matchedOn: 'LoginID',
  provenance: 'asserted',
} as const;

function setup(ownRecordsOnly = true, fields = ['ProfileLink']) {
  const { connection } = connectionFixture({
    entities: {
      incident: {
        fields: [
          field('RecId'),
          ...fields.flatMap((prefix) => [field(`${prefix}_RecID`), field(`${prefix}_Category`)]),
        ],
      },
      employee: {},
    },
    responses: {
      incidents: {
        value: [{ RecId: 'i1', ProfileLink_RecID: 'E1', ProfileLink_Category: 'Employee' }],
      },
      employees: { value: [] },
    },
  });
  return { deps: { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly, actions: OPEN_ACTIONS } };
}

function pinned(): CallContext {
  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
  context.pin?.pin({ ...PERSON });
  return context;
}

const anonymous = (): CallContext => ({ identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) });

describe('scopeToOwnRecords', () => {
  it('leaves a full-mode read exactly as the caller asked it', async () => {
    const { deps } = setup(false);
    const resolved = await resolveObject(deps, 'Incidents');

    expect(await scopeToOwnRecords(deps, anonymous(), resolved, "Status eq 'Active'")).toEqual({
      filter: "Status eq 'Active'",
    });
  });

  it('parenthesises the caller’s filter before adding the constraint', async () => {
    // `A or B and mine` is a different question from `(A or B) and mine`, and only one of them
    // is the one that was asked.
    const { deps } = setup();
    const resolved = await resolveObject(deps, 'Incidents');

    const scoped = await scopeToOwnRecords(deps, pinned(), resolved, "Status eq 'Active' or X eq 1");

    expect(scoped.filter).toBe(
      "(Status eq 'Active' or X eq 1) and ProfileLink_RecID eq 'E1'",
    );
    expect(scoped.scopedTo).toBe('Harold Sanders');
  });

  it('refuses when nobody has said who is asking', async () => {
    const { deps } = setup();
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(scopeToOwnRecords(deps, anonymous(), resolved)).rejects.toThrow(
      IdentityRequiredError,
    );
  });

  it('refuses an object with no person link rather than reading everyone’s', async () => {
    const { deps } = setup(true, []);
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(scopeToOwnRecords(deps, pinned(), resolved)).rejects.toThrow(
      UnscopableObjectError,
    );
  });

  /**
   * The wrapper is only a constraint while the caller's parentheses close what they open. This
   * filter, wrapped, is `(A) or (B) and mine` — which balances, so the check on what is SENT
   * passed it, and it returned everyone's active tickets.
   */
  it('refuses a filter that would close the wrapper early, before wrapping it', async () => {
    const { deps } = setup();
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(
      scopeToOwnRecords(deps, pinned(), resolved, "Status eq 'Active') or (Status ne 'x'"),
    ).rejects.toThrow(UnsupportedFilterError);
    await expect(
      scopeToOwnRecords(deps, pinned(), resolved, "Subject eq 'x"),
    ).rejects.toThrow(UnsupportedFilterError);
  });

  it('holds a full-mode filter to the same structure, since callers compose it too', async () => {
    const { deps } = setup(false);
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(
      scopeToOwnRecords(deps, anonymous(), resolved, 'A eq 1) or (B eq 2'),
    ).rejects.toThrow(UnsupportedFilterError);
  });
});

/**
 * The check a tool makes when it has a RecId rather than a record. Only Ivanti's not-found answer
 * means "not there"; anything else is a failure to evaluate the guard, and must say so rather than
 * tell a person their own ticket is not theirs.
 */
describe('assertOwnRecordById', () => {
  function byId(answer: unknown) {
    const { connection } = connectionFixture({
      entities: {
        incident: { fields: [field('RecId'), field('ProfileLink_RecID'), field('ProfileLink_Category')] },
        employee: {},
      },
      responses: {
        "incidents('i1')": answer,
        incidents: { value: [{ RecId: 'i1', ProfileLink_RecID: 'E1', ProfileLink_Category: 'Employee' }] },
        employees: { value: [] },
      },
    });
    return { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: true, actions: OPEN_ACTIONS };
  }

  it('reads Ivanti’s not-found answer as "not yours"', async () => {
    const deps = byId(
      new IvantiApiError({ status: 400, method: 'GET', url: 'x', body: 'ISM_4000: Invalid key' }, 'Invalid key'),
    );
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(assertOwnRecordById(deps, pinned(), resolved, 'i1')).rejects.toThrow(
      NotYourRecordError,
    );
  });

  it.each([
    ['a 500 from the tenant', new IvantiApiError({ status: 500, method: 'GET', url: 'x' }, 'boom')],
    ['the transport timing out', new IvantiApiError({ status: 0, method: 'GET', url: 'x' }, 'did not complete')],
  ])('passes %s through rather than calling the record someone else’s', async (_label, failure) => {
    const deps = byId(failure);
    const resolved = await resolveObject(deps, 'Incidents');

    const refusal = assertOwnRecordById(deps, pinned(), resolved, 'i1');

    await expect(refusal).rejects.toThrow(IvantiApiError);
    await expect(refusal).rejects.not.toThrow(NotYourRecordError);
  });

  it('accepts the caller’s own record', async () => {
    const deps = byId({ RecId: 'i1', ProfileLink_RecID: 'E1' });
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(assertOwnRecordById(deps, pinned(), resolved, 'i1')).resolves.toBeUndefined();
  });
});

describe('assertOwnRecord', () => {
  it('accepts the caller’s own record, whatever case the RecId is stored in', async () => {
    const { deps } = setup();
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(
      assertOwnRecord(deps, pinned(), resolved, { RecId: 'i1', ProfileLink_RecID: 'e1' }),
    ).resolves.toBeUndefined();
  });

  it('refuses somebody else’s', async () => {
    const { deps } = setup();
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(
      assertOwnRecord(deps, pinned(), resolved, { RecId: 'i1', ProfileLink_RecID: 'OTHER' }),
    ).rejects.toThrow(NotYourRecordError);
  });

  it('refuses a record that belongs to nobody', async () => {
    const { deps } = setup();
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(
      assertOwnRecord(deps, pinned(), resolved, { RecId: 'i1' }),
    ).rejects.toThrow(NotYourRecordError);
  });
});

describe('ownershipFields', () => {
  it('stamps both halves of the link, in the tenant’s own spelling', async () => {
    // Writing the RecId alone leaves the record pointing at a person of unstated type, which
    // the UI renders as empty.
    const { deps } = setup();
    const resolved = await resolveObject(deps, 'Incidents');

    expect(await ownershipFields(deps, pinned(), resolved)).toEqual({
      ProfileLink_RecID: 'E1',
      ProfileLink_Category: 'Employee',
      // The person authored it; the service account merely performed it. Ivanti would otherwise
      // put this server's account on every ticket an end user raises.
      CreatedBy: 'HSanders',
    });
  });

  it('adds nothing in full mode', async () => {
    const { deps } = setup(false);
    const resolved = await resolveObject(deps, 'Incidents');

    expect(await ownershipFields(deps, anonymous(), resolved)).toEqual({});
  });
});

describe('hideMissingRecord', () => {
  const notFound = new IvantiApiError({
    status: 400,
    method: 'GET',
    url: 'incidents',
    body: '{"code":"ISM_4000","message":["Invalid key"]}',
  });

  it('collapses "not there" into "not yours" for a scoped caller', () => {
    // The oracle, measured in enduser: someone else's record answered "No such record is
    // available to you." while a nonexistent one answered Ivanti's 400 gloss — so a leaked RecId
    // could be confirmed, and asking under two object names attributed it to one of them.
    expect(() => hideMissingRecord({ ownRecordsOnly: true } as never, notFound)).toThrow(
      NotYourRecordError,
    );
    expect(missingRecordMessage({ ownRecordsOnly: true } as never)).toBe(
      'No such record is available to you.',
    );
  });

  it('keeps the useful answer when the caller is not scoped', () => {
    // An analyst debugging a typo is not an adversary; "the record does not exist" is the right
    // answer in `full`.
    expect(() => hideMissingRecord({ ownRecordsOnly: false } as never, notFound)).toThrow(
      IvantiApiError,
    );
    expect(missingRecordMessage({ ownRecordsOnly: false } as never)).toBeUndefined();
  });

  it('never swallows an unrelated failure', () => {
    const boom = new IvantiApiError({ status: 500, method: 'GET', url: 'incidents' });
    expect(() => hideMissingRecord({ ownRecordsOnly: true } as never, boom)).toThrow(
      IvantiApiError,
    );
  });
});

/**
 * The closed-record guard, which is the only thing standing between a caller and a silently edited
 * closed ticket — Ivanti sets `ReadOnly: true` and then accepts a PATCH to it anyway, answering
 * 200. `docs/notes.md` records that the update path is the one place Ivanti does not hold the line.
 *
 * The guard reads the record to answer two questions at once, and the read is where it used to fail
 * open: a bare `.catch(() => undefined)` turned any transport failure into "not there", which in
 * `full` mode returns rather than throwing — so the `ReadOnly` test never ran and the write went
 * out. A guard that cannot be evaluated has to refuse, not disable itself.
 */
describe('assertRecordWritable', () => {
  /** A fixture whose single-record read answers with `record`, or throws `fails`. */
  function writable(record: Record<string, unknown> | undefined, fails?: unknown) {
    const { connection } = connectionFixture({
      entities: { incident: { fields: [field('RecId'), field('ProfileLink_RecID'), field('ProfileLink_Category')] }, employee: {} },
      responses: {
        "incidents('i1')": fails ?? (record === undefined ? { value: [] } : record),
        incidents: { value: [] },
        employees: { value: [] },
      },
    });
    return { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS };
  }

  const notFound = new IvantiApiError(
    { status: 400, method: 'GET', url: 'x', body: 'ISM_4000: Invalid key' },
    'Invalid key',
  );

  it('refuses a write to a closed record', async () => {
    const deps = writable({ RecId: 'i1', ReadOnly: true });
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(assertRecordWritable(deps, anonymous(), resolved, 'i1')).rejects.toThrow(
      /closed|read-only/i,
    );
  });

  it('allows a write to an open record', async () => {
    const deps = writable({ RecId: 'i1', ReadOnly: false });
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(assertRecordWritable(deps, anonymous(), resolved, 'i1')).resolves.toMatchObject({
      RecId: 'i1',
    });
  });

  // Ivanti's own not-found dialect still means "not there", and `full` mode leaves the explanation
  // to the calling tool rather than inventing a worse one here.
  it('reports a genuinely missing record as absent, in full mode', async () => {
    const deps = writable(undefined, notFound);
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(assertRecordWritable(deps, anonymous(), resolved, 'i1')).resolves.toBeUndefined();
  });

  // The fail-open path. Every one of these used to read as "the record is not there", skip the
  // ReadOnly test, and let the write proceed against a record that might be closed.
  it.each([
    ['a 500 from the tenant', new IvantiApiError({ status: 500, method: 'GET', url: 'x' }, 'boom')],
    ['a 502 from a proxy', new IvantiApiError({ status: 502, method: 'GET', url: 'x' }, 'bad gateway')],
    ['the transport timing out', new IvantiApiError({ status: 0, method: 'GET', url: 'x' }, 'did not complete')],
  ])('refuses the write when the guard cannot be evaluated: %s', async (_label, failure) => {
    const deps = writable(undefined, failure);
    const resolved = await resolveObject(deps, 'Incidents');

    await expect(assertRecordWritable(deps, anonymous(), resolved, 'i1')).rejects.toThrow();
  });
});
