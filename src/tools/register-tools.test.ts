// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { ANONYMOUS, assertedIdentity, verifiedIdentity, type CallerIdentity } from '../auth/identity.js';
import { createImpersonationSlot, type ImpersonationSlot } from '../auth/impersonation.js';
import { impersonatedSessionFixture } from '../ivanti/session/impersonated-session.fixture.js';
import { registerTools, selectTools } from './register-tools.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const context = { serverName: 'ivanti-mcp', serverVersion: '0.1.0', logger: logger() };

const CALL = { identity: ANONYMOUS };

const config = configFixture;

describe('selectTools', () => {
  it('exposes only get_version when no tenant is configured', () => {
    // Without a connection the Ivanti tools do not exist at all, rather than existing and
    // failing: an unregistered tool never appears in tools/list.
    expect(selectTools(config(), context).map((tool) => tool.name)).toEqual(['get_version']);
    expect(selectTools(config({ MCP_MODE: 'enduser' }), context).map((t) => t.name)).toEqual([
      'get_version',
    ]);
  });

  it('adds the schema tools once a tenant is configured', () => {
    const { connection } = connectionFixture();

    const names = selectTools(config(), { ...context, ivanti: connection }).map((t) => t.name);

    expect(names).toContain('list_business_objects');
    expect(names).toContain('get_object_metadata');
  });

  it('gives an end user the same read-only schema tools', () => {
    const { connection } = connectionFixture();

    const names = selectTools(config({ MCP_MODE: 'enduser', ENDUSER_BUSINESS_OBJECTS: ['Incident'] }), {
      ...context,
      ivanti: connection,
    }).map((t) => t.name);

    expect(names).toContain('get_object_metadata');
  });
});

describe('registerTools', () => {
  it('registers each supplied tool on the server', () => {
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;

    const { names } = registerTools(server, selectTools(config(), context), CALL, logger());

    expect(names).toEqual(['get_version']);
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool).toHaveBeenCalledWith(
      'get_version',
      expect.objectContaining({ title: 'Get server version' }),
      expect.any(Function),
    );
  });

  it('shares one config object across servers rather than rebuilding the schemas', () => {
    // This is the point of hoisting the registry: `registerTool` stores the config by
    // reference, so a shared definition means one copy of the schemas for every session.
    const tools = selectTools(config(), context);
    const a = vi.fn();
    const b = vi.fn();

    registerTools({ registerTool: a } as unknown as McpServer, tools, CALL, logger());
    registerTools({ registerTool: b } as unknown as McpServer, tools, CALL, logger());

    expect(a.mock.calls[0]?.[1]).toBe(b.mock.calls[0]?.[1]);
    // The callback is NOT shared, and must not be: it carries the identity of one conversation.
    // A shared closure would be a shared caller.
    expect(a.mock.calls[0]?.[2]).not.toBe(b.mock.calls[0]?.[2]);
  });

  it('hands every handler the context of the session that registered it', async () => {
    const registerTool = vi.fn();
    const tools = selectTools(config(), context);
    const call = { identity: assertedIdentity('jsmith'), sessionId: 's1' };

    registerTools({ registerTool } as unknown as McpServer, tools, call, logger());
    const callback = registerTool.mock.calls[0]?.[2] as (
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    await callback({});

    // get_version reports the provenance, which is how the harness can tell the paths apart.
    expect(JSON.stringify(await callback({}))).toContain('asserted');
  });

  it('audits every call without ever logging its arguments', async () => {
    const lines: { message: string; fields?: Record<string, unknown> }[] = [];
    const log = { ...logger(), info: (message: string, fields?: Record<string, unknown>) => lines.push({ message, fields }) };
    const registerTool = vi.fn();

    registerTools(
      { registerTool } as unknown as McpServer,
      selectTools(config(), context),
      { identity: assertedIdentity('jsmith'), sessionId: 's1' },
      log,
    );
    const callback = registerTool.mock.calls[0]?.[2] as (
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    await callback({ secret: 'ticket text nobody should log' });

    expect(lines[0]).toMatchObject({
      message: 'tool called',
      fields: { tool: 'get_version', sessionId: 's1', identity: 'asserted' },
    });
    // An asserted subject is a claim, not a fact, and arguments carry personal data.
    expect(JSON.stringify(lines)).not.toContain('jsmith');
    expect(JSON.stringify(lines)).not.toContain('ticket text');
  });
});

const HAROLD = {
  RecId: 'e1',
  DisplayName: 'Harold Sanders',
  FirstName: 'Harold',
  LastName: 'Sanders',
  LoginID: 'HSanders',
  PrimaryEmail: 'HSanders@example.com',
  Status: 'Active',
};

interface Result {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

/** A registered server whose tools can be called by name, as the transport would call them. */
function serve(
  tools: ReturnType<typeof selectTools>,
  options: {
    idleMs?: number;
    impersonation?: ImpersonationSlot;
    identity?: CallerIdentity;
    logger?: Logger;
  } = {},
) {
  const registerTool = vi.fn();
  const handle = registerTools(
    { registerTool } as unknown as McpServer,
    tools,
    {
      identity: options.identity ?? ANONYMOUS,
      ...(options.impersonation === undefined ? {} : { impersonation: options.impersonation }),
    },
    options.logger ?? logger(),
    options.idleMs,
  );

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
    const entry = registerTool.mock.calls.find((made) => made[0] === name);
    const callback = entry?.[2] as (a: Record<string, unknown>) => Promise<Result>;
    return callback(args);
  };

  return { call, handle, names: handle.names };
}

/** A configured tenant, so `act_as` exists and the gate is live. */
function tenant(
  options: {
    idleMs?: number;
    impersonation?: ImpersonationSlot;
    identity?: CallerIdentity;
    logger?: Logger;
    responses?: Record<string, unknown>;
  } = {},
) {
  const { connection } = connectionFixture({
    entities: { employee: {} },
    responses: options.responses ?? { $filter: { value: [HAROLD] } },
  });
  return serve(selectTools(config(), { ...context, ivanti: connection }), options);
}

/** A token that names Harold by the claim `act_as` looks a person up with. */
const SIGNED_IN = verifiedIdentity({
  subject: 'opaque-pairwise-id',
  issuer: 'https://idp',
  scopes: [],
  claims: { email: 'HSanders@example.com' },
});

/**
 * The gate every call passes through, tested at the level the transport calls: a handler invoked
 * directly in a unit test never meets it, which is exactly why it lives here and not in a tool.
 */
describe('the identity gate', () => {
  it('refuses every tool but act_as until somebody is pinned', async () => {
    const { call, names } = tenant();
    expect(names).toContain('act_as');
    expect(names.length).toBeGreaterThan(20);

    for (const name of names.filter((tool) => tool !== 'act_as')) {
      const result = await call(name);
      // Refused before the handler ran, so nothing was asked of Ivanti on nobody's behalf.
      expect(result.isError, name).toBe(true);
      expect(result.content[0]?.text, name).toContain('act_as');
    }
  });

  it('gates get_version too: a version is an answer, and answers wait for a person', async () => {
    const { call } = tenant();
    expect((await call('get_version')).isError).toBe(true);
  });

  it('answers once act_as has pinned somebody', async () => {
    const { call } = tenant();

    expect((await call('act_as', { person: 'HSanders' })).isError).toBeUndefined();
    expect((await call('get_version')).isError).toBeUndefined();
  });

  it('cannot require an identity where nothing can pin one', async () => {
    // No tenant, so `act_as` is not registered. Gating the one remaining tool would leave a
    // server that answers nothing at all and offers no way to fix that.
    const { call, names } = serve(selectTools(config(), context));

    expect(names).toEqual(['get_version']);
    expect((await call('get_version')).isError).toBeUndefined();
  });
});

describe('the conversation', () => {
  const opener = (): ImpersonationSlot =>
    createImpersonationSlot(() =>
      Promise.resolve(impersonatedSessionFixture({ loginId: 'HSanders' })),
    );

  it('forgets the person once it has gone quiet, and hands the Ivanti session back', async () => {
    vi.useFakeTimers();
    try {
      const impersonation = opener();
      const { call } = tenant({ idleMs: 1_000, impersonation });

      await call('act_as', { person: 'HSanders' });
      expect(impersonation.session()).toBeDefined();
      expect((await call('get_version')).isError).toBeUndefined();

      vi.advanceTimersByTime(1_001);

      // This is the stdio fix: one process is one connection for its whole life, so without
      // this the first person stayed pinned through every conversation that followed.
      expect((await call('get_version')).isError).toBe(true);
      // Given back rather than left to expire — the slot refuses a second login while it holds
      // one, so a conversation that kept it would refuse the next person by name.
      expect(impersonation.session()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the person while the conversation is still being had', async () => {
    vi.useFakeTimers();
    try {
      const { call } = tenant({ idleMs: 1_000 });
      await call('act_as', { person: 'HSanders' });

      for (let turn = 0; turn < 5; turn += 1) {
        vi.advanceTimersByTime(900);
        expect((await call('get_version')).isError).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends when the client initializes again on the same connection', async () => {
    const impersonation = opener();
    const { call, handle } = tenant({ impersonation });

    await call('act_as', { person: 'HSanders' });
    expect((await call('get_version')).isError).toBeUndefined();

    await handle.endConversation();

    expect((await call('get_version')).isError).toBe(true);
    expect(impersonation.session()).toBeUndefined();
  });

  it('refuses a call that outlived the conversation it was made in', async () => {
    vi.useFakeTimers();
    try {
      const { connection } = connectionFixture({ entities: { employee: {} } });
      let release!: () => void;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      // A directory lookup still in flight when the conversation ends. `act_as` used to pin the
      // discarded pin and answer `pinned: true`, after which every other tool refused — the model
      // was told it had an identity and then contradicted on the next call.
      (connection.people as unknown as { directory: unknown }).directory = {
        find: async () => {
          await slow;
          return [
            {
              recId: 'e1',
              category: 'employee',
              displayName: 'Harold Sanders',
              loginId: 'HSanders',
              primaryEmail: 'HSanders@example.com',
              matchedOn: 'login',
              status: 'Active',
            },
          ];
        },
      };

      const { call } = serve(
        selectTools(config(), { ...context, ivanti: connection }),
        { idleMs: 1_000 },
      );

      const pending = call('act_as', { person: 'HSanders' });
      vi.advanceTimersByTime(1_001);
      await call('get_version');
      release();

      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('conversation ended while that call was running');
      // And the conversation really is empty, rather than holding somebody it never reported.
      expect((await call('get_version')).isError).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts over, rather than remembering the last person it was told about', async () => {
    const { call, handle } = tenant();
    const pinnedIn = async (): Promise<Record<string, unknown>> =>
      JSON.parse((await call('act_as', { person: 'HSanders' })).content[0]?.text ?? '{}') as Record<
        string,
        unknown
      >;

    await pinnedIn();
    // Within one conversation the same person again is recognised as the same person.
    expect(await pinnedIn()).toMatchObject({ pinned: true, repeated: true });

    await handle.endConversation();

    // Across conversations they are somebody this one has not met — which is what makes room
    // for a different person, the case stdio could never reach before.
    expect(await pinnedIn()).toMatchObject({ pinned: true, repeated: false });
  });
});

describe('a signed-in conversation', () => {
  it('pins itself on the first call that needs it', async () => {
    const { call } = tenant({ identity: SIGNED_IN });

    // No `act_as` in sight: the token already named the person, and making the model repeat what
    // the issuer said is a round trip that can only go wrong.
    const result = await call('get_version');

    expect(result.isError).toBeUndefined();
  });

  it('resolves the person once, however many calls arrive together', async () => {
    const { connection } = connectionFixture({
      entities: { employee: {} },
      responses: { $filter: { value: [HAROLD] } },
    });
    const find = vi.fn(() =>
      Promise.resolve([
        {
          recId: 'e1',
          category: 'employee',
          displayName: 'Harold Sanders',
          loginId: 'HSanders',
          primaryEmail: 'HSanders@example.com',
          matchedOn: 'email',
          status: 'Active',
        },
      ]),
    );
    (connection.people as unknown as { directory: unknown }).directory = { find };

    const { call } = serve(selectTools(config(), { ...context, ivanti: connection }), {
      identity: SIGNED_IN,
    });

    const answers = await Promise.all([call('get_version'), call('get_version'), call('get_version')]);

    expect(answers.every((answer) => answer.isError === undefined)).toBe(true);
    // One lookup shared, not one per caller — and no caller refused for losing the race.
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('reports what act_as said when the token names nobody, as the failure it is', async () => {
    const { call } = tenant({
      identity: SIGNED_IN,
      // Nobody matches the claim.
      responses: { $filter: { value: [] }, $search: { value: [] } },
    });

    const result = await call('get_version');

    expect(result.isError).toBe(true);
    // The useful explanation is act_as's own, under a line saying which question failed.
    expect(result.content[0]?.text).toContain('who you are from the signed-in token');
    expect(JSON.stringify(result.content)).toContain('administrator');
  });

  it('does not sign in a conversation that only claims to be someone', async () => {
    // An asserted identity is a claim, and a claim has to be made deliberately through act_as.
    const { call } = tenant({ identity: assertedIdentity('HSanders') });

    const result = await call('get_version');

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('act_as');
  });

  it('signs in again after the conversation ends', async () => {
    const { call, handle } = tenant({ identity: SIGNED_IN });
    expect((await call('get_version')).isError).toBeUndefined();

    await handle.endConversation();

    expect((await call('get_version')).isError).toBeUndefined();
  });
});
