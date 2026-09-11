import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config/env-schema.js';
import type { IvantiConnection } from '../ivanti/connect.js';
import type { Logger } from '../logger.js';
import { createGetVersionTool } from './get-version.js';
import { createCountRecordsTool } from './records/count-records.js';
import { createGetRecordTool } from './records/get-record.js';
import { createGetRelatedRecordsTool } from './records/get-related-records.js';
import { createListAssignedWorkTool } from './records/list-assigned-work.js';
import { createListRecordsTool } from './records/list-records.js';
import { createGetAttachmentDetailsTool } from './attachments/get-attachment-details.js';
import { createFetchTool } from './search/fetch.js';
import { createFulltextSearchObjectTool } from './search/fulltext-search-object.js';
import { createSearchTool } from './search/search.js';
import { createGetServiceRequestParameterOptionsTool } from './service-request/get-service-request-parameter-options.js';
import { createGetServiceRequestParametersTool } from './service-request/get-service-request-parameters.js';
import { createGetObjectMetadataTool } from './schema/get-object-metadata.js';
import { createGetPickListValuesTool } from './schema/get-pick-list-values.js';
import { createListBusinessObjectsTool } from './schema/list-business-objects.js';
import { createObjectGate } from './shared/object-gate.js';
import type { ToolDefinition } from './tool-definition.js';

export interface ToolContext {
  serverName: string;
  serverVersion: string;
  logger: Logger;
  /** Absent when no tenant is configured: the Ivanti tools then do not exist at all. */
  ivanti?: IvantiConnection;
}

/**
 * Decides which tools exist for a given audience.
 *
 * Narrowing happens here, at registration, rather than inside handlers: a tool that is
 * not registered never appears in `tools/list`, so the model cannot call it at all.
 */
export function selectTools(config: Config, context: ToolContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [createGetVersionTool(context)];

  if (context.ivanti === undefined) return tools;

  const deps = {
    connection: context.ivanti,
    gate: createObjectGate(config),
    logger: context.logger,
  };

  // Reads first: they need no session and work with any key role.
  tools.push(
    createListBusinessObjectsTool(deps),
    createGetObjectMetadataTool(deps),
    createGetRecordTool(deps),
    createListRecordsTool(deps),
    createCountRecordsTool(deps),
    createGetRelatedRecordsTool(deps),
    createFulltextSearchObjectTool(deps),
    createListAssignedWorkTool(deps),
    createGetServiceRequestParametersTool(deps),
    createGetServiceRequestParameterOptionsTool(deps),
    createGetAttachmentDetailsTool(deps),
    // The retrievable pair: a connector that lacks either one is marked as not implementing
    // retrieval, and some clients then hide every other tool on it.
    createSearchTool(deps),
    createFetchTool(deps),
  );

  // Needs the ASMX session: the allowed values live on a create form, which OData cannot see.
  if (context.ivanti.capability.tier !== 'odata') {
    tools.push(createGetPickListValuesTool(deps));
  }

  if (config.MCP_MODE === 'full') {
    // Tools an end user must not have land here.
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
