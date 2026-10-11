// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { withLogContext, type Logger } from '../../logger.js';
import { recordToolCall } from '../../metrics/server-metrics.js';
import { withCallUsage, type CallUsage } from '../../usage/call-usage.js';
import { callSize } from '../shared/call-size.js';
import { declaredArguments } from '../strict-input.js';
import type { ManifestFingerprint } from '../manifest-fingerprint.js';
import type { ToolDefinition } from '../tool-definition.js';
import type { Conversation } from './conversation.js';

/** What the pipeline learns about a call as it runs, for the usage line. */
export interface CallRecord {
  usage: CallUsage;
  /** The conversation the call turned out to belong to. */
  began: { conversation?: number };
}

export interface CallLog {
  around: (
    tool: ToolDefinition,
    args: Record<string, unknown>,
    // Optional only because tests call the callback bare; the SDK always passes it.
    extra: { requestId?: RequestId } | undefined,
    run: (record: CallRecord) => Promise<CallToolResult>,
  ) => Promise<CallToolResult>;
}

/**
 * Wraps one call in its log context and its usage line.
 *
 * Every line the call causes — down to the `ivanti request` lines in `src/ivanti` — says which call
 * it belongs to: under HTTP conversations interleave, and a request line that does not say whose
 * it is cannot be joined to anything.
 */
export function createCallLog(
  server: McpServer,
  conversation: Conversation,
  logger: Logger,
  /** Stamped on every usage line, so the report can compare one version of the text with another. */
  manifest?: ManifestFingerprint,
): CallLog {
  return {
    around: (tool, args, extra, run) =>
      withLogContext(
        { tool: tool.name, ...conversation.session(), rpcId: extra?.requestId },
        async () => {
          const record: CallRecord = { usage: { ivantiRequests: 0 }, began: {} };
          const { usage, began } = record;
          const started = Date.now();
          let result: CallToolResult | undefined;
          try {
            result = await withCallUsage(usage, () => run(record));
            return result;
          } finally {
            // What this call put into the conversation, in characters — sizes and markers only,
            // never content. `pnpm usage:report` reads these back; see docs/development.md.
            const answered = result === undefined ? 'fault' : result.isError === true ? 'error' : 'ok';
            const ms = Date.now() - started;
            recordToolCall(tool.name, usage.outcome ?? answered, ms);
            logger.info('tool finished', {
              tool: tool.name,
              ...conversation.session(),
              // Unique across sessions and processes, so a report can follow one conversation
              // through a log that interleaves many — stdio lines have no session id at all.
              conversation: `${conversation.instance}.${String(began.conversation ?? conversation.id())}`,
              ...clientOf(server),
              ...manifest,
              outcome: usage.outcome ?? answered,
              ...callSize(args, result),
              ...(usage.rowsRead === undefined ? {} : { rowsRead: usage.rowsRead }),
              ivantiRequests: usage.ivantiRequests,
              ms,
            });
          }
        },
      ),
  };
}

/**
 * The arguments that say WHICH record a write touched: its object, a relationship, and anything
 * named `…Id` — `recordId`, `targetId`, `approvalId`, `attachmentId`, `actionId`,
 * `subscriptionId`. Identifiers and schema names, never values: `fields`, `note`, `answers` and
 * the rest carry ticket text and personal data, and stay unlogged.
 *
 * Read from the declared schema rather than listed by hand, so a write tool added later is
 * audited by what it declares instead of by someone remembering to add it here.
 */
const TARGET_ARGUMENT = /^(object|relationship)$|Id$/;

/** An id is 32 characters. Anything much longer in one of these is not an id, and is cut. */
const MAX_TARGET_CHARS = 64;

export function targetArguments(tool: ToolDefinition): readonly string[] {
  // A read touches nothing, so it names nothing — its arguments stay out of the log entirely.
  if (tool.config.annotations.readOnlyHint === true) return [];
  return Object.keys(declaredArguments(tool.config.inputSchema)).filter((name) =>
    TARGET_ARGUMENT.test(name),
  );
}

/**
 * Which record a write was aimed at, for the audit line. Without it a `delete_record` line said
 * who deleted something and never what.
 */
export function auditTargets(
  names: readonly string[],
  args: Record<string, unknown>,
): { targets?: Record<string, string> } {
  const targets: Record<string, string> = {};
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' || typeof value === 'number') {
      targets[name] = String(value).slice(0, MAX_TARGET_CHARS);
    }
  }
  return Object.keys(targets).length === 0 ? {} : { targets };
}

/**
 * Which client made the call, as it named itself at `initialize` — the nearest a server gets to
 * knowing the model, which MCP never says. Absent before `initialize`, and in tests.
 */
function clientOf(server: McpServer): { client?: string } {
  const client = (server as Partial<McpServer>).server?.getClientVersion();
  return client === undefined ? {} : { client: `${client.name}/${client.version}` };
}
