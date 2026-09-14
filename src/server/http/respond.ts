// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { ServerResponse } from 'node:http';

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * A JSON-RPC shaped error, for failures on the MCP endpoint.
 *
 * Transport-level refusals still have to look like JSON-RPC, because the client parses the
 * body before it looks at the status code.
 */
export function sendRpcError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { jsonrpc: '2.0', error: { code: -32600, message }, id: null });
}
