import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config/env-schema.js';
import { createGetVersionTool } from './get-version.js';
import type { ToolDefinition } from './tool-definition.js';

export interface ToolContext {
  serverName: string;
  serverVersion: string;
}

/**
 * Decides which tools exist for a given audience.
 *
 * Narrowing happens here, at registration, rather than inside handlers: a tool that is
 * not registered never appears in `tools/list`, so the model cannot call it at all.
 */
export function selectTools(config: Config, context: ToolContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [createGetVersionTool(context)];

  if (config.MCP_MODE === 'full') {
    // Business Object tools land here once they exist.
  }

  return tools;
}

/**
 * Registers already-built definitions onto one server.
 *
 * Takes the tools rather than building them, so every session shares one set of definitions.
 * `registerTool` stores the config by reference, so the zod schemas exist once in memory no
 * matter how many sessions are open.
 */
export function registerTools(server: McpServer, tools: readonly ToolDefinition[]): string[] {
  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }

  return tools.map((tool) => tool.name);
}
