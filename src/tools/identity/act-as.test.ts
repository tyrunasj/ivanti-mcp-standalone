import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import type { Logger } from '../../logger.js';
import { createActAsTool } from './act-as.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { ANONYMOUS, verifiedIdentity } from '../../auth/identity.js';
import type { CallContext } from '../tool-definition.js';

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
  return createActAsTool({ connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly });
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
