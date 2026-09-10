import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config/env-schema.js';
import { registerTools, selectTools } from '../tools/register-tools.js';
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
export function createServerFactory(config: Config): ServerFactory {
  const tools = selectTools(config, {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
  });

  return {
    toolNames: tools.map((tool) => tool.name),
    create: (): McpServer => {
      const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
      registerTools(server, tools);
      return server;
    },
  };
}
