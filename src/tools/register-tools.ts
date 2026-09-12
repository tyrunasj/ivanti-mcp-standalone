import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config/env-schema.js';
import type { IvantiConnection } from '../ivanti/connect.js';
import type { Logger } from '../logger.js';
import { createGetVersionTool } from './get-version.js';
import { createCountRecordsTool } from './records/count-records.js';
import { createCreateRecordTool } from './records/create-record.js';
import { createDeleteRecordTool } from './records/delete-record.js';
import { createUpdateRecordTool } from './records/update-record.js';
import { createLinkRecordsTool } from './relationships/link-records.js';
import { createUnlinkRecordsTool } from './relationships/unlink-records.js';
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
import { auditFields } from '../auth/identity.js';
import type { CallContext, ToolDefinition } from './tool-definition.js';

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

  // An end user may raise a ticket on an allowlisted object; the gate already holds that line.
  tools.push(createCreateRecordTool(deps));

  if (config.MCP_MODE === 'full') {
    // Editing and deleting wait for `enduser` to learn what "own records" means: without that,
    // an end-user deployment would let anyone change anyone's ticket. Fail closed until B7.
    tools.push(
      createUpdateRecordTool(deps),
      createDeleteRecordTool(deps),
      createLinkRecordsTool(deps),
      createUnlinkRecordsTool(deps),
    );
  }

  return tools;
}

/**
 * Registers already-built definitions onto one server, bound to one call context.
 *
 * Takes the tools rather than building them, so every session shares one set of definitions:
 * `registerTool` stores the **config** by reference, so the zod schemas exist once however many
 * sessions are open. Only the small closure that carries the context is per session, which is
 * what makes identity a per-conversation fact rather than a global.
 *
 * Every call is audited here because this is the one place they all pass through. Arguments are
 * never logged — they carry ticket text and personal data — so the record is what was called, by
 * which session, on whose behalf, and how that was established.
 */
export function registerTools(
  server: McpServer,
  tools: readonly ToolDefinition[],
  context: CallContext,
  logger: Logger,
): string[] {
  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, (args: Record<string, unknown>) => {
      logger.info('tool called', {
        tool: tool.name,
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        ...auditFields(context.identity),
      });
      return tool.handler(args, context);
    });
  }

  return tools.map((tool) => tool.name);
}
