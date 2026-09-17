// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config/env-schema.js';
import type { IvantiConnection } from '../ivanti/connect.js';
import type { Logger } from '../logger.js';
import {
  createImpersonationSlot,
  type ImpersonationSlot,
  type SessionOpener,
} from '../auth/impersonation.js';
import {
  openImpersonatedSession,
  type ImpersonatedSession,
} from '../ivanti/session/impersonated-session.js';
import { registerTools, selectTools } from '../tools/register-tools.js';
import { registerResources, selectResources } from '../resources/register-resources.js';
import type { CallContext } from '../tools/tool-definition.js';
import { buildInstructions } from './instructions.js';
import { readPackageMetadata } from '../version.js';

// package.json is the single source of truth for both, so a published image and the version it
// reports cannot disagree.
const { name: SERVER_NAME, version: SERVER_VERSION } = readPackageMetadata();

export { SERVER_NAME, SERVER_VERSION };

export interface ServerFactory {
  /** Names of the tools every server produced by this factory exposes. */
  toolNames: string[];
  /** URIs of the reference documents it exposes. Empty when no tenant is configured. */
  resourceUris: string[];
  /**
   * A fresh server per connection — the SDK forbids one instance holding two transports — bound
   * to the identity that connection established.
   */
  create: (context: CallContext) => McpServer;
}

/**
 * Builds the tool definitions **once**, then hands out a server per connection.
 *
 * The split matters because `Protocol.connect()` refuses a second transport ("use a separate
 * Protocol instance per connection"), so servers must be per-session — but the definitions
 * they register need not be. Building them once keeps a session cheap: its cost is a map of
 * names pointing at shared objects, not a rebuilt copy of every schema.
 */
export interface ServerFactoryDeps {
  logger: Logger;
  /** Absent when no tenant is configured. */
  ivanti?: IvantiConnection;
}

/**
 * Gives an Ivanti session back when the conversation holding it ends.
 *
 * Exported so the guarantee can be tested on the path that actually runs, rather than on a
 * reconstruction of it. It chains rather than replaces: `onclose` may already carry the SDK's own
 * teardown, and dropping that to add this would trade one leak for another.
 */
export function releaseOnClose(server: McpServer, slot: ImpersonationSlot): void {
  const previous = server.server.onclose;
  server.server.onclose = (): void => {
    void slot.release();
    previous?.call(server.server);
  };
}

/**
 * A fresh `initialize` on a live connection is a new conversation, so the previous one ends.
 *
 * Chains rather than replaces, for the same reason `releaseOnClose` does: the SDK sets its own
 * handler and dropping it would trade one bug for another. A connection's *first* `initialize`
 * fires this too, which is a no-op — there is nobody pinned yet to forget.
 */
export function endOnInitialize(server: McpServer, endConversation: () => Promise<void>): void {
  const previous = server.server.oninitialized;
  server.server.oninitialized = (): void => {
    void endConversation();
    previous?.call(server.server);
  };
}

export function createServerFactory(config: Config, deps: ServerFactoryDeps): ServerFactory {
  // Built once, from process-wide facts. `canImpersonate` is the gate: a deployment whose
  // ConfigDB is unconfigured or unreachable gets no opener, so no connection gets a slot, so
  // `act_as` keeps its existing meaning without a single conditional in the tools.
  const ivanti = deps.ivanti;
  const centralConfig =
    ivanti?.capability.canImpersonate === true ? ivanti.centralConfig : undefined;
  const opener: SessionOpener | undefined =
    ivanti !== undefined && centralConfig !== undefined
      ? (login: string): Promise<ImpersonatedSession> =>
          openImpersonatedSession({
            centralConfig,
            routes: ivanti.transport.routes,
            // The tenant hostname IS Ivanti's `tenantId`. Taken from the URL that actually
            // answered at startup rather than re-derived from configuration.
            tenantHost: new URL(ivanti.metadataUrl).hostname,
            login,
            mode: config.MCP_MODE,
            enduserRole: config.ENDUSER_ROLE,
            ...(config.IVANTI_IMPERSONATION_ROLE === undefined
              ? {}
              : { pinnedRole: config.IVANTI_IMPERSONATION_ROLE }),
            logger: deps.logger,
          })
      : undefined;

  const toolContext = {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    logger: deps.logger,
    ...(deps.ivanti === undefined ? {} : { ivanti: deps.ivanti }),
  };

  const tools = selectTools(config, toolContext);
  // Built once for the same reason the tools are: the text is shared by reference, so a session
  // costs a map entry rather than a copy of every document.
  const resources = selectResources(config, toolContext);

  const instructions = buildInstructions({
    capability: deps.ivanti?.capability,
    mode: config.MCP_MODE,
    resourceUris: resources.map((resource) => resource.uri),
  });

  return {
    toolNames: tools.map((tool) => tool.name),
    resourceUris: resources.map((resource) => resource.uri),
    create: (context: CallContext): McpServer => {
      const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        // Said once, at connect time, rather than repeated in every tool description.
        instructions === undefined ? {} : { instructions },
      );

      // Per connection, like the pin — and released here rather than anywhere else, so the thing
      // that creates an Ivanti session is the thing that gives it back.
      const impersonation = opener === undefined ? undefined : createImpersonationSlot(opener);
      if (impersonation !== undefined) releaseOnClose(server, impersonation);

      // Its own knob: on stdio this is the only thing that ends a conversation, and how long a
      // person's records stay reachable is not the same question as how long a dead HTTP session
      // may hold memory.
      const { endConversation, mayAnswer } = registerTools(
        server,
        tools,
        { ...context, ...(impersonation === undefined ? {} : { impersonation }) },
        deps.logger,
        config.MCP_IDENTITY_IDLE_TTL_SECONDS * 1000,
      );
      endOnInitialize(server, endConversation);
      registerResources(server, resources, mayAnswer);
      return server;
    },
  };
}
