import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from './tool-definition.js';

export interface VersionInfo {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
}

export interface GetVersionDeps {
  serverName: string;
  serverVersion: string;
  /** Injected so the negotiated protocol version can be asserted in tests. */
  protocolVersion?: string;
}

export function buildVersionInfo(deps: GetVersionDeps): VersionInfo {
  return {
    serverName: deps.serverName,
    serverVersion: deps.serverVersion,
    protocolVersion: deps.protocolVersion ?? LATEST_PROTOCOL_VERSION,
  };
}

export function createGetVersionTool(deps: GetVersionDeps): ToolDefinition {
  return {
    name: 'get_version',
    config: {
      title: 'Get server version',
      description:
        'Returns the name and version of this MCP server and the MCP protocol version it ' +
        'implements. Useful for confirming which build a client is talking to.',
      annotations: {
        title: 'Get server version',
        readOnlyHint: true,
        idempotentHint: true,
        // Answers from process-local state; it reaches nothing external.
        openWorldHint: false,
      },
    },
    handler: () => ({
      content: [{ type: 'text', text: JSON.stringify(buildVersionInfo(deps), null, 2) }],
    }),
  };
}
