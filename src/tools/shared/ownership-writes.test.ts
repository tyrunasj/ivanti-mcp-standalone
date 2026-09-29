// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from './action-gate.js';
import { OPEN_GATE } from './object-gate.js';
import { assertOwnershipUntouched, OwnershipFieldError } from './ownership-writes.js';
import { FieldNameError } from './explain-field-error.js';
import { resolveObject } from './resolve-object.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A change keeps its customer in `RequestorLink`, not `ProfileLink` — discovered, not assumed. */
function setup(ownRecordsOnly = true) {
  const { connection } = connectionFixture({
    entities: {
      change: {
        fields: [
          field('RecId'),
          field('Subject'),
          field('CreatedBy'),
          field('ProfileLink_RecID'),
          field('RequestorLink_RecID'),
          field('RequestorLink_Category'),
        ],
      },
      employee: {},
    },
    responses: {
      changes: { value: [{ RecId: 'c1', RequestorLink_RecID: 'E1', RequestorLink_Category: 'Employee' }] },
      employees: { value: [] },
    },
  });
  const deps = { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly, actions: OPEN_ACTIONS };
  return { deps, target: () => resolveObject(deps, 'Changes') };
}

describe('assertOwnershipUntouched', () => {
  it('guards the link this object actually uses, found the way scoping finds it', async () => {
    const { deps, target } = setup();

    await expect(
      assertOwnershipUntouched(deps, await target(), { requestorlink_recid: 'E2' }),
    ).rejects.toThrow(OwnershipFieldError);
    // Not this object's customer link, so not a way to hand the record over.
    await expect(
      assertOwnershipUntouched(deps, await target(), { ProfileLink_RecID: 'E2' }),
    ).resolves.toBeUndefined();
  });

  it('guards the author and the bare link name', async () => {
    const { deps, target } = setup();

    for (const fields of [{ CreatedBy: 'someone' }, { RequestorLink: 'Becky Smith' }]) {
      await expect(assertOwnershipUntouched(deps, await target(), fields)).rejects.toThrow(
        /whose record this is/,
      );
    }
  });

  it('lets a create repeat its own stamp, and nothing else', async () => {
    const { deps, target } = setup();
    const stamp = { RequestorLink_RecID: 'E1', RequestorLink_Category: 'Employee', CreatedBy: 'HSanders' };

    await expect(
      assertOwnershipUntouched(deps, await target(), { requestorlink_category: 'employee' }, stamp),
    ).resolves.toBeUndefined();
    await expect(
      assertOwnershipUntouched(deps, await target(), { CreatedBy: 'BSmith' }, stamp),
    ).rejects.toThrow(/filed for the person you are acting for automatically/);
  });

  it('is a field refusal, which the tool runner answers as the caller\'s to fix', async () => {
    const { deps, target } = setup();

    await expect(
      assertOwnershipUntouched(deps, await target(), { CreatedBy: 'x' }),
    ).rejects.toThrow(FieldNameError);
  });

  it('guards nothing in full mode', async () => {
    const { deps, target } = setup(false);

    await expect(
      assertOwnershipUntouched(deps, await target(), { RequestorLink_RecID: 'E2', CreatedBy: 'x' }),
    ).resolves.toBeUndefined();
  });
});
