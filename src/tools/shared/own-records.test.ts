// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from './object-gate.js';
import { OPEN_ACTIONS } from './action-gate.js';
import type { Logger } from '../../logger.js';
import {
  IdentityRequiredError,
  NotYourRecordError,
  UnscopableObjectError,
  assertOwnRecord,
  hideMissingRecord,
  missingRecordMessage,
  ownershipFields,
  scopeToOwnRecords,
} from './own-records.js';
import { IvantiApiError } from '../../ivanti/http/errors.js';
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
