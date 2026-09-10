export interface RpcSummary {
  /** JSON-RPC method, e.g. `tools/call`. */
  rpcMethod?: string;
  /** Tool name, when the method is `tools/call`. */
  tool?: string;
  /** Number of messages, when the client sent a batch. */
  batch?: number;
}

function summarise(message: unknown): RpcSummary {
  if (typeof message !== 'object' || message === null) return {};
  const record = message as Record<string, unknown>;
  const rpcMethod = typeof record.method === 'string' ? record.method : undefined;

  const params = record.params;
  const tool =
    rpcMethod === 'tools/call' && typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>).name
      : undefined;

  return {
    ...(rpcMethod !== undefined ? { rpcMethod } : {}),
    ...(typeof tool === 'string' ? { tool } : {}),
  };
}

/**
 * Summarises a JSON-RPC body for logging.
 *
 * Deliberately extracts only the method and tool name. Arguments are never logged: a
 * `tools/call` payload carries whatever the user typed, which for an ITSM server means ticket
 * contents and personal data.
 */
export function describeRpc(body: unknown): RpcSummary {
  if (Array.isArray(body)) {
    return { ...summarise(body[0]), batch: body.length };
  }
  return summarise(body);
}
