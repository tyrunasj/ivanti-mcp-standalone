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
import { createGetLinkFieldsTool } from './schema/get-link-fields.js';
import { createGetPickListConstraintsTool } from './schema/get-pick-list-constraints.js';
import { createGetPickListValuesTool } from './schema/get-pick-list-values.js';
import { createGroupCountTool } from './records/group-count.js';
import { createPreviewDeleteTool } from './records/preview-delete.js';
import { createListQuickActionsTool } from './quick-actions/list-quick-actions.js';
import { createPreviewQuickActionTool } from './quick-actions/preview-quick-action.js';
import { createRunQuickActionTool } from './quick-actions/run-quick-action.js';
import { createListSavedSearchesTool } from './search/list-saved-searches.js';
import { createSavedSearchTool } from './search/saved-search.js';
import { createListBusinessObjectsTool } from './schema/list-business-objects.js';
import { createObjectGate } from './shared/object-gate.js';
import { createActAsTool } from './identity/act-as.js';
import { auditFields } from '../auth/identity.js';
import { createSessionPin } from '../auth/identity-pin.js';
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

  const enduser = config.MCP_MODE === 'enduser';

  const deps = {
    connection: context.ivanti,
    gate: createObjectGate(config),
    logger: context.logger,
    ownRecordsOnly: enduser,
  };

  // Who the conversation is helping. First in both modes, and in `enduser` the gate every record
  // tool below stands behind.
  tools.push(createActAsTool(deps));

  // Reads first: they need no session and work with any key role.
  tools.push(
    createListBusinessObjectsTool(deps),
    createGetObjectMetadataTool(deps),
    createGetRecordTool(deps),
    createListRecordsTool(deps),
    createCountRecordsTool(deps),
    createGetRelatedRecordsTool(deps),
    createFulltextSearchObjectTool(deps),
    createGetServiceRequestParametersTool(deps),
    createGetServiceRequestParameterOptionsTool(deps),
    createGetAttachmentDetailsTool(deps),
    // The retrievable pair: a connector that lacks either one is marked as not implementing
    // retrieval, and some clients then hide every other tool on it.
    createSearchTool(deps),
    createFetchTool(deps),
  );

  // "Assigned to me" is a staff question: it asks who is *working* a record, where an end user
  // only ever asks who it is *for*. Scoping it would not make it meaningful.
  if (!enduser) tools.push(createListAssignedWorkTool(deps));

  // Need the ASMX session: all of these live on a workspace or a create form, which OData
  // cannot see.
  if (context.ivanti.capability.tier !== 'odata') {
    tools.push(
      createGetPickListValuesTool(deps),
      createGetPickListConstraintsTool(deps),
      createGetLinkFieldsTool(deps),
      createGroupCountTool(deps),
    );

    // Staff surfaces, all of which answer across everyone or for the service account. A saved
    // search called "My …" records *this server's* account, so presenting one to an end user as
    // their own would be a lie the model could not detect.
    if (!enduser) {
      tools.push(
        createListSavedSearchesTool(deps),
        createSavedSearchTool(deps),
        createListQuickActionsTool(deps),
        createPreviewQuickActionTool(deps),
        createPreviewDeleteTool(deps),
      );
    }
  }

  // An end user may raise a ticket on an allowlisted object; the gate holds which objects, and
  // `ownershipFields` makes the ticket theirs.
  tools.push(createCreateRecordTool(deps));

  // Editing and deleting are now safe in `enduser` too: both read the record first and refuse one
  // that is not the caller's. Linking is not — `unlink_records` on a Contains relationship
  // severs a *third* record from its parent, which no ownership check on the two named records
  // would catch.
  tools.push(createUpdateRecordTool(deps), createDeleteRecordTool(deps));

  if (!enduser) {
    tools.push(createLinkRecordsTool(deps), createUnlinkRecordsTool(deps));

    // Runs whatever the tenant defined — email, child records, status changes — and repeats it
    // on retry. It needs the session, so it lands only where both hold.
    if (context.ivanti.capability.tier !== 'odata') tools.push(createRunQuickActionTool(deps));
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
  // One pin per server, and a server is one connection — so the identity a conversation settles
  // on cannot reach another, and stdio (which has no session id to key a map by) is covered by
  // the same object as everything else.
  const bound: CallContext = { ...context, pin: createSessionPin(context.identity) };

  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, (args: Record<string, unknown>) => {
      logger.info('tool called', {
        tool: tool.name,
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        ...auditFields(bound.pin?.identity() ?? context.identity),
      });
      return tool.handler(args, bound);
    });
  }

  return tools.map((tool) => tool.name);
}
