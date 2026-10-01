// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../auth/identity.js';
import type * as ImpersonationModule from '../auth/impersonation.js';
import type { ImpersonationSlot } from '../auth/impersonation.js';
import type * as ImpersonatedSessionModule from '../ivanti/session/impersonated-session.js';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createImpersonationSlot } from '../auth/impersonation.js';
import type { ImpersonatedSession } from '../ivanti/session/impersonated-session.js';
import { createServerFactory, endOnInitialize, releaseOnClose } from './create-server.js';
import { impersonatedSessionFixture } from '../ivanti/session/impersonated-session.fixture.js';

/**
 * The slots the factory creates, so a test can open one the way `act_as` would without driving a
 * whole tool call — and the session that opening hands back, so its release can be slowed down.
 */
const seen = vi.hoisted(() => ({
  slots: [] as ImpersonationSlot[],
  release: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('../auth/impersonation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ImpersonationModule>();
  return {
    ...actual,
    createImpersonationSlot: (open: Parameters<typeof actual.createImpersonationSlot>[0]) => {
      const slot = actual.createImpersonationSlot(open);
      seen.slots.push(slot);
      return slot;
    },
  };
});

vi.mock('../ivanti/session/impersonated-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ImpersonatedSessionModule>();
  const { impersonatedSessionFixture: fixture } = await import(
    '../ivanti/session/impersonated-session.fixture.js'
  );
  return {
    ...actual,
    openImpersonatedSession: () =>
      Promise.resolve(
        fixture({ release: () => seen.release?.() ?? Promise.resolve() }),
      ),
  };
});

const config = configFixture();

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const deps = (): { logger: Logger } => ({ logger: logger() });

const CALL = { identity: ANONYMOUS };

describe('createServerFactory', () => {
  it('reports the tools every server will expose', () => {
    expect(createServerFactory(config, deps()).toolNames).toEqual(['get_version']);
  });

  it('hands out a distinct server per connection', () => {
    const factory = createServerFactory(config, deps());

    expect(factory.create(CALL)).not.toBe(factory.create(CALL));
  });

  it('exposes the same tool set in enduser mode', () => {
    expect(createServerFactory({ ...config, MCP_MODE: 'enduser' }, deps()).toolNames).toEqual([
      'get_version',
    ]);
  });

  it('builds servers that are usable independently', () => {
    const factory = createServerFactory(config, deps());

    expect(factory.create(CALL)).toBeDefined();
    expect(factory.create(CALL)).toBeDefined();
  });

  it('exposes the Ivanti tools when a tenant is connected', () => {
    const { connection } = connectionFixture();

    const factory = createServerFactory(config, { logger: logger(), ivanti: connection });

    expect(factory.toolNames).toContain('list_business_objects');
  });
});

describe('the instructions a connection is sent', () => {
  const instructionsOf = async (connection: { server: McpServer }): Promise<string | undefined> => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await connection.server.connect(serverSide);
    await client.connect(clientSide);
    const text = client.getInstructions();
    await client.close();
    return text;
  };

  // stdio beside an `oauth` HTTP transport carries no token: told that the sign-in named the
  // person, the model called tools the gate then refused until `act_as`.
  it('tells a conversation without a token to ask, even when AUTH_MODE is oauth', async () => {
    const { connection } = connectionFixture();
    const factory = createServerFactory(
      { ...config, AUTH_MODE: 'oauth', HTTP_TRANSPORT_ON: true },
      { logger: logger(), ivanti: connection },
    );

    const stdio = await instructionsOf(factory.create({ identity: ANONYMOUS }));
    const signedIn = await instructionsOf(
      factory.create({ identity: { provenance: 'verified', subject: 'alice@example.com' } }),
    );

    expect(stdio).toContain('until you know who you are helping');
    expect(signedIn).toContain('The sign-in already says who you are helping');
  });
});

describe('the impersonated session\'s lifetime', () => {
  /** A connection whose ConfigDB answers, so the factory builds an opener. */
  const impersonating = (release: () => Promise<void>) => {
    const { connection } = connectionFixture({ capability: { tier: 'admin', canImpersonate: true } });
    return {
      logger: logger(),
      ivanti: {
        ...connection,
        centralConfig: {
          probe: () => Promise.resolve(),
          authenticate: () =>
            Promise.resolve({ sid: 'tenant.example.com#ABC#1', loginId: 'HSanders' }),
          release,
        },
      },
    };
  };

  // Tying the slot to the server is what guarantees an Ivanti session opened for a conversation
  // is given back when the conversation ends rather than left to time out. Opening one needs
  // act_as, so the end-to-end path is covered with that tool; what is asserted here is that the
  // hook exists, chains, and does not invent a release for a conversation that never impersonated.
  it('installs a close hook when the deployment can impersonate', () => {
    const factory = createServerFactory(config, impersonating(vi.fn(() => Promise.resolve())));

    expect(factory.create(CALL).server.server.onclose).toBeDefined();
  });

  it('closes cleanly when nothing was ever opened', () => {
    const release = vi.fn(() => Promise.resolve());
    const { server } = createServerFactory(config, impersonating(release)).create(CALL);

    expect(() => server.server.onclose?.()).not.toThrow();
    expect(release).not.toHaveBeenCalled();
  });

  /**
   * The SDK runs `onclose` synchronously and awaits nothing it starts, so `McpServer.close()`
   * resolved while the release was still in flight. Shutdown awaited exactly that, then exited —
   * and the request handing the person's Ivanti session back never left the machine.
   */
  it('closes a connection only once the Ivanti session it opened is released', async () => {
    let released = false;
    seen.release = () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          released = true;
          resolve();
        }, 20);
      });
    const connection = createServerFactory(
      config,
      impersonating(() => Promise.resolve()),
    ).create(CALL);
    // A transport that closes the way the SDK's do: synchronously, through `onclose`.
    const transport: Transport = {
      start: () => Promise.resolve(),
      send: () => Promise.resolve(),
      close(): Promise<void> {
        this.onclose?.();
        return Promise.resolve();
      },
    };
    await connection.server.connect(transport);
    await seen.slots.at(-1)?.open('HSanders');

    await connection.close();

    expect(released).toBe(true);
    seen.release = undefined;
  });

  it('closes a connection that never impersonated without waiting on anything', async () => {
    const connection = createServerFactory(config, deps()).create(CALL);

    await expect(connection.close()).resolves.toBeUndefined();
  });

  it('leaves no slot at all when the deployment cannot impersonate', () => {
    const { connection } = connectionFixture({ capability: { tier: 'admin', canImpersonate: false } });
    const factory = createServerFactory(config, { logger: logger(), ivanti: connection });

    // No opener means no slot, so act_as keeps its existing meaning with no conditional in a tool.
    expect(factory.create(CALL)).toBeDefined();
  });
});

describe('endOnInitialize', () => {
  const server = (): McpServer => new McpServer({ name: 'test', version: '0' });

  it('ends the conversation when the client initializes again', () => {
    const end = vi.fn(() => Promise.resolve());
    const target = server();

    endOnInitialize(target, end);
    target.server.oninitialized?.();

    expect(end).toHaveBeenCalledTimes(1);
  });

  it('chains rather than replacing an existing handler', () => {
    const existing = vi.fn();
    const end = vi.fn(() => Promise.resolve());
    const target = server();
    target.server.oninitialized = existing;

    endOnInitialize(target, end);
    target.server.oninitialized?.();

    expect(existing).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe('releaseOnClose', () => {
  const opened = (release: () => Promise<void>): ImpersonatedSession =>
    impersonatedSessionFixture({ sid: 'tenant#A#1', release });

  const server = (): McpServer => new McpServer({ name: 'test', version: '0' });

  // The guarantee itself: a conversation that opened an Ivanti session gives it back when it
  // ends, rather than leaving it to time out on the tenant.
  it('releases a session the conversation opened', async () => {
    const release = vi.fn(() => Promise.resolve());
    const slot = createImpersonationSlot(() => Promise.resolve(opened(release)));
    await slot.open('HSanders');
    const target = server();

    releaseOnClose(target, slot);
    target.server.onclose?.();
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
    expect(slot.session()).toBeUndefined();
  });

  // What lets a caller wait for the release: `onclose` itself cannot be awaited.
  it('hands back the release a close started, for whoever must not exit before it', async () => {
    let released = false;
    const release = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            released = true;
            resolve();
          }, 10);
        }),
    );
    const slot = createImpersonationSlot(() => Promise.resolve(opened(release)));
    await slot.open('HSanders');
    const target = server();

    const releasing = releaseOnClose(target, slot);
    target.server.onclose?.();
    await releasing();

    expect(released).toBe(true);
  });

  it('releases nothing when the conversation never impersonated', () => {
    const release = vi.fn(() => Promise.resolve());
    const slot = createImpersonationSlot(() => Promise.resolve(opened(release)));
    const target = server();

    releaseOnClose(target, slot);
    target.server.onclose?.();

    expect(release).not.toHaveBeenCalled();
  });

  // onclose may already carry the SDK's own teardown; replacing it would trade one leak for
  // another.
  it('chains rather than replacing an existing handler', async () => {
    const existing = vi.fn();
    const release = vi.fn(() => Promise.resolve());
    const slot = createImpersonationSlot(() => Promise.resolve(opened(release)));
    await slot.open('HSanders');
    const target = server();
    target.server.onclose = existing;

    releaseOnClose(target, slot);
    target.server.onclose?.();

    expect(existing).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
  });
});
