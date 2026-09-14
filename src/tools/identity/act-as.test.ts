// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import type { Logger } from '../../logger.js';
import { createActAsTool } from './act-as.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { ANONYMOUS, verifiedIdentity } from '../../auth/identity.js';
import type { CallContext } from '../tool-definition.js';
import { createImpersonationSlot } from '../../auth/impersonation.js';
import type { ImpersonatedSession } from '../../ivanti/session/impersonated-session.js';
import { impersonatedSessionFixture } from '../../ivanti/session/impersonated-session.fixture.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const HAROLD = {
  RecId: 'e1',
  DisplayName: 'Harold Sanders',
  FirstName: 'Harold',
  LastName: 'Sanders',
  LoginID: 'HSanders',
  PrimaryEmail: 'HSanders@saasitdemo.com',
  Status: 'Active',
};

function setup(responses: Record<string, unknown>, ownRecordsOnly = true) {
  const { connection } = connectionFixture({ entities: { employee: {} }, responses });
  return createActAsTool({ connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly, actions: OPEN_ACTIONS });
}

const ctx = (identity = ANONYMOUS): CallContext => ({
  identity,
  pin: createSessionPin(identity),
});

const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content[0]?.text ?? '';

const body = (result: { content: { type: string; text?: string }[] }): Record<string, unknown> =>
  JSON.parse(text(result)) as Record<string, unknown>;

describe('act_as', () => {
  it('pins the person when exactly one matches', async () => {
    const tool = setup({ $filter: { value: [HAROLD] } });
    const context = ctx();

    const result = await tool.handler({ person: 'HSanders' }, context);

    expect(result.isError).toBeUndefined();
    expect(body(result)['pinned']).toBe(true);
    expect(context.pin?.person()?.recId).toBe('e1');
    // Resolving a claim does not verify it.
    expect(context.pin?.person()?.provenance).toBe('asserted');
  });

  it('asks which one, and pins nobody, when several match', async () => {
    const tool = setup({
      $search: {
        value: [
          { RecId: 'a', DisplayName: 'John Smith', FirstName: 'John', LastName: 'Smith', LoginID: 'JSmith' },
          { RecId: 'b', DisplayName: 'John Davis', FirstName: 'John', LastName: 'Davis', LoginID: 'JDavis' },
        ],
      },
    });
    const context = ctx();

    const result = await tool.handler({ person: 'John' }, context);

    expect(body(result)['pinned']).toBe(false);
    expect(body(result)['matches']).toHaveLength(2);
    expect(context.pin?.person()).toBeUndefined();
  });

  it('pins once the caller names which one', async () => {
    const tool = setup({
      $search: {
        value: [
          { RecId: 'a', DisplayName: 'John Smith', FirstName: 'John', LastName: 'Smith', LoginID: 'JSmith' },
          { RecId: 'b', DisplayName: 'John Davis', FirstName: 'John', LastName: 'Davis', LoginID: 'JDavis' },
        ],
      },
    });
    const context = ctx();

    await tool.handler({ person: 'John' }, context);
    // Choosing from the list is not a second, different claim: it is the same conversation
    // narrowing the same question, so the conflict rule must not fire.
    const chosen = await tool.handler({ person: 'JDavis' }, context);

    expect(body(chosen)['pinned']).toBe(true);
    expect(context.pin?.person()?.displayName).toBe('John Davis');
  });

  it('says it could not find them, rather than returning nothing', async () => {
    const tool = setup({ employees: { value: [] } });

    const result = await tool.handler({ person: 'nobody' }, ctx());

    expect(result.isError).toBe(true);
    // The distinction the model would otherwise get wrong, and report as "you have no tickets".
    expect(text(result)).toContain('not the same as them having no tickets');
  });

  it('refuses to act as someone marked Terminated', async () => {
    const tool = setup({ $filter: { value: [{ ...HAROLD, Status: 'Terminated' }] } });
    const context = ctx();

    const result = await tool.handler({ person: 'HSanders' }, context);

    expect(result.isError).toBe(true);
    expect(context.pin?.person()).toBeUndefined();
  });

  it('flags a status that is neither active nor terminated, and still pins', async () => {
    const tool = setup({ $filter: { value: [{ ...HAROLD, Status: 'On Leave' }] } });
    const context = ctx();

    const result = await tool.handler({ person: 'HSanders' }, context);

    expect(body(result)['warning']).toContain('On Leave');
    expect(context.pin?.person()?.recId).toBe('e1');
  });

  it('refuses a second, different person', async () => {
    const tool = setup({
      $filter: {
        value: [HAROLD, { ...HAROLD, RecId: 'e2', DisplayName: 'Ada Dale', LoginID: 'ADale' }],
      },
    });
    const context = ctx();

    await tool.handler({ person: 'HSanders' }, context);
    const second = await tool.handler({ person: 'ADale' }, context);

    expect(second.isError).toBe(true);
    // The name may have come from a ticket the conversation just read, and the refusal says so.
    expect(text(second)).toContain('If that name came from a record');
    expect(context.pin?.person()?.displayName).toBe('Harold Sanders');
  });

  describe('when the conversation carries a token', () => {
    const VERIFIED = verifiedIdentity({
      subject: 'opaque-pairwise-id',
      issuer: 'https://idp',
      scopes: [],
      claims: { email: 'HSanders@saasitdemo.com' },
    });

    it('looks up the token’s claim and ignores the name it was handed', async () => {
      const tool = setup({ $filter: { value: [HAROLD] } });
      const context = ctx(VERIFIED);

      // A claimed name must not be able to widen the search to someone else.
      const result = await tool.handler({ person: 'somebody-else' }, context);

      expect(body(result)['pinned']).toBe(true);
      expect(context.pin?.person()?.displayName).toBe('Harold Sanders');
      expect(context.pin?.person()?.provenance).toBe('verified');
    });

    it('asks for confirmation when the token matched only on a name', async () => {
      const tool = setup({
        $search: {
          value: [
            { RecId: 'e9', DisplayName: 'Harold Sanders', FirstName: 'Harold', LastName: 'Sanders' },
          ],
        },
      });
      const context = ctx(
        verifiedIdentity({
          subject: 's',
          issuer: 'https://idp',
          scopes: [],
          claims: { email: 'Harold Sanders' },
        }),
      );

      const result = await tool.handler({}, context);

      // The token proves who they are; it does not prove which record is theirs.
      expect(body(result)['pinned']).toBe(false);
      expect(text(result)).toContain('confirm');
      expect(context.pin?.person()).toBeUndefined();
    });

    it('explains itself when the token names nobody', async () => {
      const tool = setup({ $filter: { value: [HAROLD] } });
      const context = ctx(
        verifiedIdentity({ subject: 'opaque', issuer: 'https://idp', scopes: [], claims: {} }),
      );

      const result = await tool.handler({}, context);

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('OAUTH_IDENTITY_CLAIM');
    });
  });
});

describe('act_as when the deployment can impersonate', () => {
  const session = (overrides: Partial<ImpersonatedSession> = {}): ImpersonatedSession =>
    impersonatedSessionFixture({
      sid: 'tenant#A#1',
      roles: [
        { name: 'ServiceDeskAnalyst', displayName: 'Service Desk Analyst', selfService: false },
        { name: 'SelfServiceMobile', displayName: 'Self Service', selfService: true },
      ],
      ...overrides,
    });

  const impersonatingCtx = (
    open: (login: string) => Promise<ImpersonatedSession>,
  ): CallContext => ({
    identity: ANONYMOUS,
    pin: createSessionPin(ANONYMOUS),
    impersonation: createImpersonationSlot(open),
  });

  it('opens an Ivanti session as the person it pinned', async () => {
    const open = vi.fn(() => Promise.resolve(session()));
    const tool = setup({ $filter: { value: [HAROLD] } });

    const result = await tool.handler({ person: 'HSanders' }, impersonatingCtx(open));

    // The LOGIN, not the display name: Ivanti authenticates a session by login.
    expect(open).toHaveBeenCalledWith('HSanders');
    expect(body(result)['role']).toBe('ServiceDeskAnalyst');
    expect(body(result)['otherRoles']).toEqual(['SelfServiceMobile']);
    expect(String(body(result)['scope'])).toContain('their own access');
  });

  // Silently answering as the service account would tell the caller something false about whose
  // data they are reading — the one outcome this feature exists to prevent.
  it('refuses the call when the session cannot be opened, rather than falling back', async () => {
    const tool = setup({ $filter: { value: [HAROLD] } });

    const result = await tool.handler(
      { person: 'HSanders' },
      impersonatingCtx(() => Promise.reject(new Error('Ivanti has no enabled user named HSanders.'))),
    );

    expect(text(result)).toContain('will not answer as though I had');
    // The actionable half of Ivanti's reason survives into the refusal.
    expect(text(result)).toContain('no enabled user');
  });

  it('refuses a person who has no Ivanti login to authenticate as', async () => {
    const noLogin = { ...HAROLD, LoginID: undefined };
    const tool = setup({ $filter: { value: [noLogin] } });

    const result = await tool.handler({ person: 'Harold Sanders' }, impersonatingCtx(() => Promise.resolve(session())));

    expect(text(result)).toContain('no Ivanti login');
  });

  // Without the ConfigDB pair there is no slot, and act_as keeps the meaning it always had.
  it('says nothing about roles when the deployment cannot impersonate', async () => {
    const tool = setup({ $filter: { value: [HAROLD] } });

    const result = await tool.handler({ person: 'HSanders' }, ctx());

    expect(body(result)['role']).toBeUndefined();
    expect(String(body(result)['scope'])).not.toContain('their own access');
  });
});

describe('a failed impersonation must not bind the conversation', () => {
  // Found on a live tenant: act_as pinned the person, THEN tried to open the session. The open
  // failed, the error was returned — and the pin had already stuck, so the conversation was
  // bound to someone it could not act as and refused every other person for the rest of its
  // life. One unlucky name bricked the session.
  it('leaves the conversation free to try someone else', async () => {
    const tool = setup({ $filter: { value: [HAROLD] } });
    const slot = createImpersonationSlot(() =>
      Promise.reject(new Error('This person holds no self-service role.')),
    );
    const context: CallContext = {
      identity: ANONYMOUS,
      pin: createSessionPin(ANONYMOUS),
      impersonation: slot,
    };

    const refused = await tool.handler({ person: 'HSanders' }, context);

    expect(refused.isError).toBe(true);
    // The point: nothing was pinned, so the next attempt is not blocked by the failed one.
    expect(context.pin?.person()).toBeUndefined();
  });

  // The pin's own rules still gate the attempt — they must run BEFORE a session is opened, or an
  // injected second name would mint an Ivanti session for someone the conversation will refuse.
  it('refuses a second person without opening a session for them', async () => {
    const tool = setup({ $filter: { value: [HAROLD] } });
    const open = vi.fn(() => Promise.reject(new Error('should never be reached')));
    const context: CallContext = {
      identity: ANONYMOUS,
      pin: createSessionPin(ANONYMOUS),
      impersonation: createImpersonationSlot(open),
    };
    // Someone else is already pinned.
    context.pin?.pin({
      recId: 'other',
      displayName: 'Someone Else',
      category: 'employee',
      provenance: 'asserted',
      matchedOn: 'LoginID',
    });

    const refused = await tool.handler({ person: 'HSanders' }, context);

    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('already acting for Someone Else');
    expect(open).not.toHaveBeenCalled();
  });
});
