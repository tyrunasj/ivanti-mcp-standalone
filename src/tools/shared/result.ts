import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Results are JSON text.
 *
 * Not `structuredContent`: that requires an `outputSchema`, and Ivanti records have no fixed
 * shape — the fields are whatever the tenant configured. A JSON document in a text block is what
 * every client can read today.
 */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
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
