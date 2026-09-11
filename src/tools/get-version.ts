import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { readSdkVersion } from '../version.js';
import { jsonResult } from './shared/result.js';
import { defineTool, type ToolDefinition } from './tool-definition.js';

export interface VersionInfo {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  sdkVersion: string;
}

export interface GetVersionDeps {
  serverName: string;
  serverVersion: string;
  /** Injected so the versions can be asserted in tests. */
  protocolVersion?: string;
  sdkVersion?: string;
}

export function buildVersionInfo(deps: GetVersionDeps): VersionInfo {
  return {
    serverName: deps.serverName,
    serverVersion: deps.serverVersion,
    protocolVersion: deps.protocolVersion ?? LATEST_PROTOCOL_VERSION,
    sdkVersion: deps.sdkVersion ?? readSdkVersion(),
  };
}

export function createGetVersionTool(deps: GetVersionDeps): ToolDefinition {
  return defineTool({
    name: 'get_version',
    title: 'Get server version',
    description:
      'Returns the name and version of this MCP server, the MCP protocol version it ' +
      'implements, and the SDK version it is built on. Useful for confirming which build a ' +
      'client is talking to.',
    annotations: {
      title: 'Get server version',
      readOnlyHint: true,
      idempotentHint: true,
      // Answers from process-local state; it reaches nothing external.
      openWorldHint: false,
    },
    inputSchema: {},
    handler: () => jsonResult(buildVersionInfo(deps)),
  });
}
