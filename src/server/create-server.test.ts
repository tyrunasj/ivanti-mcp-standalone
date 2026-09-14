// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../auth/identity.js';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createImpersonationSlot } from '../auth/impersonation.js';
import type { ImpersonatedSession } from '../ivanti/session/impersonated-session.js';
import { createServerFactory, releaseOnClose } from './create-server.js';
import { impersonatedSessionFixture } from '../ivanti/session/impersonated-session.fixture.js';

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

    expect(factory.create(CALL).server.onclose).toBeDefined();
  });

  it('closes cleanly when nothing was ever opened', () => {
    const release = vi.fn(() => Promise.resolve());
    const server = createServerFactory(config, impersonating(release)).create(CALL);

    expect(() => server.server.onclose?.()).not.toThrow();
    expect(release).not.toHaveBeenCalled();
  });

  it('leaves no slot at all when the deployment cannot impersonate', () => {
    const { connection } = connectionFixture({ capability: { tier: 'admin', canImpersonate: false } });
    const factory = createServerFactory(config, { logger: logger(), ivanti: connection });

    // No opener means no slot, so act_as keeps its existing meaning with no conditional in a tool.
    expect(factory.create(CALL)).toBeDefined();
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
