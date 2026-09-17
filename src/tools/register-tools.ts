// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
import { createUploadAttachmentTool } from './attachments/upload-attachment.js';
import { createDownloadAttachmentTool } from './attachments/download-attachment.js';
import { createDeleteAttachmentTool } from './attachments/delete-attachment.js';
import { createListRequestOfferingsTool } from './service-request/list-request-offerings.js';
import { createAddNoteTool } from './notes/add-note.js';
import { createSearchKnowledgeTool } from './knowledge/search-knowledge.js';
import { createListApprovalsTool } from './approvals/list-approvals.js';
import { createVoteOnApprovalTool } from './approvals/vote-on-approval.js';
import { createListNotesTool } from './notes/list-notes.js';
import { createSubmitServiceRequestTool } from './service-request/submit-service-request.js';
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
import { createActionGate } from './shared/action-gate.js';
import { createActAsTool } from './identity/act-as.js';
import { switchRoleTool } from './identity/switch-role.js';
import { auditFields } from '../auth/identity.js';
import { createSessionPin, IdentityRequiredError } from '../auth/identity-pin.js';
import { errorResult } from './shared/result.js';
import type { CallContext, ToolDefinition } from './tool-definition.js';

/** The one tool that answers before anyone is pinned, because it is what does the pinning. */
const ACT_AS = 'act_as';

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
    actions: createActionGate(config),
  };

  // Who the conversation is helping. First in both modes, and in `enduser` the gate every record
  // tool below stands behind.
  tools.push(createActAsTool(deps));

  // `full` only. `enduser` opens the self-service role ENDUSER_ROLE names and stays there — a
  // tool that could change it would undo the one thing that makes that mode end-user. Deciding
  // it here rather than inside the handler means it never appears in `tools/list` at all.
  if (!enduser) tools.push(switchRoleTool(deps));

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

    // The tenant's own procedures — closing, reopening, cancelling. An end user gets them only
    // where the deployment named which ones (`ENDUSER_QUICK_ACTIONS`), and only on their own
    // records; `full` gets the whole surface. This is the general mechanism rather than a
    // close/reopen tool: the verbs are the tenant's, and their names are tenant text.
    if (!enduser || deps.actions.allowed.length > 0) {
      tools.push(
        createListQuickActionsTool(deps),
        createPreviewQuickActionTool(deps),
        createRunQuickActionTool(deps),
      );
    }

    // Staff surfaces, all of which answer across everyone or for the service account. A saved
    // search called "My …" records *this server's* account, so presenting one to an end user as
    // their own would be a lie the model could not detect.
    if (!enduser) {
      tools.push(
        createListSavedSearchesTool(deps),
        createSavedSearchTool(deps),
        createPreviewDeleteTool(deps),
      );
    }
  }

  // An end user may raise a ticket on an allowlisted object; the gate holds which objects, and
  // `ownershipFields` makes the ticket theirs.
  tools.push(createCreateRecordTool(deps));

  // Approvals are read, never cast: a vote would be recorded as this server's service account
  // rather than as the approver. See the tool for why that is not a gap worth closing.
  tools.push(createListApprovalsTool(deps));

  // Casting one needs the session, because the decision travels as a quick action on the vote
  // row — the only form of it that records the approver rather than this server's account.
  if (context.ivanti.capability.tier !== 'odata') tools.push(createVoteOnApprovalTool(deps));

  // The knowledge base, reached only through here: the allowlist can say which objects but not
  // which rows of one, and the audience rule here is a row filter.
  tools.push(createSearchKnowledgeTool(deps));

  // Notes, reached through the record they are on rather than by naming the note object — so
  // the allowlist keeps meaning "these tickets" and a note follows its ticket's ownership.
  tools.push(createListNotesTool(deps), createAddNoteTool(deps));

  // The service catalog. Both need to know who the request is for, which `act_as` supplies in
  // either mode — so they are registered in both.
  tools.push(createListRequestOfferingsTool(deps), createSubmitServiceRequestTool(deps));

  // Attaching a file to a record, and removing one. Both gate on the record the file hangs off
  // rather than on the attachment table, so an end user reaches only their own.
  tools.push(
    createUploadAttachmentTool(deps),
    createDownloadAttachmentTool(deps),
    createDeleteAttachmentTool(deps),
  );

  // Editing and deleting are now safe in `enduser` too: both read the record first and refuse one
  // that is not the caller's. Linking is not — `unlink_records` on a Contains relationship
  // severs a *third* record from its parent, which no ownership check on the two named records
  // would catch.
  tools.push(createUpdateRecordTool(deps), createDeleteRecordTool(deps));

  if (!enduser) {
    tools.push(createLinkRecordsTool(deps), createUnlinkRecordsTool(deps));
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
 * Every call is audited here, and gated here, because this is the one place they all pass
 * through. Arguments are never logged — they carry ticket text and personal data — so the record
 * is what was called, by which session, on whose behalf, and how that was established.
 */
export interface RegisteredTools {
  /** The names registered, in the order they were given. */
  names: string[];
  /**
   * Ends the conversation: the pin is thrown away and the next call starts with nobody.
   *
   * Handed out rather than exposed on the pin, because a tool holds a `SessionPin` and must never
   * be able to end the conversation it is bound by — that would be a way out of the pin, which is
   * the one thing the pin exists to prevent. Only the caller that built the connection gets this.
   */
  endConversation: () => Promise<void>;
  /**
   * Whether this conversation may be answered at all — false until `act_as` has pinned somebody.
   *
   * Published so that anything else registered on the same server asks the same question rather
   * than re-deriving it: "is there an identity" and "does this deployment require one" are two
   * conditions, and a second copy of them is a second thing to get wrong.
   */
  mayAnswer: () => boolean;
}

/**
 * How a conversation ends, and why a stdio process has to be told.
 *
 * Over HTTP a conversation *is* a session: the store sweeps it once it goes quiet and the whole
 * server — pin included — is thrown away with it. A stdio process has no such thing. It is one
 * connection for the life of the process, so a client that keeps the server running across
 * conversations, which is the ordinary shape, carried the first person's pin into every
 * conversation that followed: the person outlived the conversation that named them.
 *
 * Two signals end one, and neither is within the model's reach — a tool that could end a
 * conversation could shed the pin, which is the one thing the pin exists to prevent:
 *
 * - **Silence.** No tool call for `idleMs` — `MCP_IDENTITY_IDLE_TTL_SECONDS`. Its own setting,
 *   not the session sweep's: how long a person's records stay reachable to whoever is at the
 *   keyboard is not the same question as how long a dead HTTP session may hold memory.
 * - **A fresh `initialize`.** The client saying so itself, which is exact but arrives only from
 *   clients that re-initialize rather than reconnect. Silence is the one that always arrives.
 */
export function registerTools(
  server: McpServer,
  tools: readonly ToolDefinition[],
  context: CallContext,
  logger: Logger,
  /** Omitted means a conversation never goes stale on its own — the shape every test wants. */
  idleMs?: number,
): RegisteredTools {
  // One pin per conversation, and a new conversation gets a new one: re-creating is the whole of
  // "this conversation is over", and it leaves the pin's own rules with no reset to be tricked
  // into. `bound` is re-made with it so handlers read the current pin rather than a captured one.
  let pin = createSessionPin(context.identity);
  let bound: CallContext = { ...context, pin };
  let lastCallAt = Date.now();
  // Which conversation a running call belongs to. A handler captures the pin it was given, so one
  // that is still running when its conversation ends is holding a discarded object — and `act_as`
  // would pin THAT one and report success, leaving the model certain it had an identity while
  // every later call refused. Counting is cheaper than making forty-one handlers re-read a pin.
  let conversation = 0;
  // The one in-flight attempt to pin a signed-in conversation, shared by concurrent callers.
  let signingIn: Promise<CallToolResult> | undefined;

  const session = context.sessionId === undefined ? {} : { sessionId: context.sessionId };

  const endConversation = async (reason: 'idle' | 'reinitialized'): Promise<void> => {
    const held = pin.person() !== undefined;
    pin = createSessionPin(context.identity);
    bound = { ...context, pin };
    conversation += 1;
    signingIn = undefined;
    if (!held) return;

    // The person is never named here: on an asserted pin it is a claim, and an audit line that
    // records a claim as a fact is worse than one that records nothing.
    logger.info('conversation ended; identity forgotten', { reason, ...session });
    // Given back, not left to expire: the next person cannot open a session while this one holds
    // the slot, and `act_as` would refuse them by naming somebody they never asked about.
    await context.impersonation?.release();
  };

  // `act_as` is the only tool that answers before an identity is pinned — and a deployment that
  // does not register it cannot require one. With no tenant configured the only tool is
  // `get_version`, and gating that would leave a server able to answer nothing at all.
  const identityRequired = tools.some((tool) => tool.name === ACT_AS);
  const mayAnswer = (): boolean => !identityRequired || pin.person() !== undefined;

  const actAs = tools.find((tool) => tool.name === ACT_AS);

  /**
   * A **signed-in** conversation pins itself, on the first call that needs it.
   *
   * The token already names the person, so making the model call `act_as` to repeat what the
   * issuer said is a round trip that can only go wrong. It runs here rather than at `initialize`
   * for two reasons: pinning does real work against Ivanti — a directory lookup, and an
   * impersonation handshake where that is configured — so a slow or unreachable tenant would fail
   * the *connection* rather than a call; and a token that matched only on a name has to ask for
   * confirmation, which needs somewhere to ask.
   *
   * `act_as`'s own handler does it, never a second copy: the rules about what a token may match,
   * what it must confirm, and what it refuses are subtle enough that two implementations would
   * differ, and the weaker one would be this one. An asserted session is untouched — there is
   * nothing to pin from but a claim, and a claim has to be made deliberately.
   *
   * Returns what `act_as` said when it did not pin, so the caller reports that rather than a
   * generic refusal; `undefined` means it was not attempted or it worked.
   */
  const pinFromToken = async (): Promise<CallToolResult | undefined> => {
    if (actAs === undefined || pin.identity().provenance !== 'verified') return undefined;

    // One attempt per conversation, shared by concurrent callers — the same shape the Ivanti
    // session handshake has, and for the same reason: a cold conversation that fired two calls
    // would otherwise run two lookups, and the loser would be refused for losing.
    if (signingIn === undefined) {
      logger.info('resolving the signed-in identity without being asked', {
        ...session,
        ...auditFields(pin.identity()),
      });
      signingIn = Promise.resolve(actAs.handler({}, bound));
    }

    const answer = await signingIn;
    if (mayAnswer()) return undefined;

    // It could not pin: the token names nobody in Ivanti, or matched a record that has to be
    // confirmed first. Its explanation is the useful one, but the call the caller actually made
    // did not happen — so it is marked as the failure it is, and said to be about identity rather
    // than about what they asked for.
    return {
      ...answer,
      isError: true,
      content: [
        {
          type: 'text' as const,
          text:
            'Before answering that, this conversation had to work out who you are from the ' +
            'signed-in token, and could not:',
        },
        ...answer.content,
      ],
    };
  };

  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, async (args: Record<string, unknown>) => {
      const at = Date.now();
      const quiet = idleMs !== undefined && at - lastCallAt >= idleMs;
      lastCallAt = at;
      if (quiet) await endConversation('idle');

      // Read after any expiry above, so a call that ends the previous conversation belongs to the
      // new one rather than being refused by its own arrival.
      const startedIn = conversation;

      logger.info('tool called', {
        tool: tool.name,
        ...session,
        ...auditFields(pin.identity()),
      });

      // The gate, at the one place every call passes through. Tool by tool it would be
      // forgettable, and a tool that forgot would not fail — it would answer, for nobody.
      if (tool.name !== ACT_AS && !mayAnswer()) {
        const unresolved = await pinFromToken();

        if (!mayAnswer()) {
          logger.info('tool refused on identity', {
            tool: tool.name,
            reason: 'IdentityRequiredError',
          });
          return unresolved ?? errorResult(new IdentityRequiredError().message);
        }
      }

      const result = await tool.handler(args, bound);

      // Ended underneath us. The result was computed for a conversation that is over, and for
      // `act_as` it was computed against a pin nothing reads any more — so it is refused rather
      // than reported, which is the difference between "call me again" and a silent lie.
      if (conversation !== startedIn) {
        logger.info('result discarded; the conversation ended first', { tool: tool.name, ...session });
        return errorResult(
          'This conversation ended while that call was running, so its result was discarded. ' +
            'Call `act_as` again to say who you are helping, then retry.',
        );
      }

      return result;
    });
  }

  return {
    names: tools.map((tool) => tool.name),
    endConversation: () => endConversation('reinitialized'),
    mayAnswer,
  };
}
