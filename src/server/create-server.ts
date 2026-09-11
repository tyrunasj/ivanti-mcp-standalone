import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config/env-schema.js';
import type { IvantiConnection } from '../ivanti/connect.js';
import type { Logger } from '../logger.js';
import { registerTools, selectTools } from '../tools/register-tools.js';
import { buildInstructions } from './instructions.js';
import { readPackageMetadata } from '../version.js';

// package.json is the single source of truth for both, so a published image and the version it
// reports cannot disagree.
const { name: SERVER_NAME, version: SERVER_VERSION } = readPackageMetadata();

export { SERVER_NAME, SERVER_VERSION };

export interface ServerFactory {
  /** Names of the tools every server produced by this factory exposes. */
  toolNames: string[];
  /** A fresh server per connection — the SDK forbids one instance holding two transports. */
  create: () => McpServer;
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

export function createServerFactory(config: Config, deps: ServerFactoryDeps): ServerFactory {
  const instructions = buildInstructions(deps.ivanti?.capability);

  const tools = selectTools(config, {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    logger: deps.logger,
    ...(deps.ivanti === undefined ? {} : { ivanti: deps.ivanti }),
  });

  return {
    toolNames: tools.map((tool) => tool.name),
    create: (): McpServer => {
      const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        // Said once, at connect time, rather than repeated in every tool description.
        instructions === undefined ? {} : { instructions },
      );
      registerTools(server, tools);
      return server;
    },
  };
}
