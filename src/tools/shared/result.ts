// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Results are JSON text — compact.
 *
 * Not `structuredContent`: that requires an `outputSchema`, and Ivanti records have no fixed
 * shape — the fields are whatever the tenant configured. A JSON document in a text block is what
 * every client can read today.
 *
 * Compact, because the reader is a model, not a person, and a result is re-sent with every
 * request after it. Indentation was about a third of every result's characters (an incident's
 * metadata: 20,258 pretty, 13,861 compact) and told the model nothing the braces did not.
 */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * A failure the model should see and can act on — a wrong field name, an unknown Business
 * Object — rather than a protocol error, which the model cannot read.
 */
export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
