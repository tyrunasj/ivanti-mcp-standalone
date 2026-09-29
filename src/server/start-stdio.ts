// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpConnection } from './create-server.js';

export interface StdioServer {
  /** Ends the conversation and waits for its Ivanti session to be handed back. Idempotent. */
  close: () => Promise<void>;
  /**
   * Settles once the client has gone — stdin ended — and the conversation has been closed.
   *
   * The SDK's transport listens for data and errors, never for the end of input, so a client that
   * exited left the process to drain its event loop and die with the person's Ivanti session
   * still open on the tenant.
   */
  ended: Promise<void>;
}

/**
 * Serves one conversation over stdin and stdout.
 *
 * The streams are parameters for tests. Nothing here writes to `output` except the transport:
 * under stdio it IS the JSON-RPC stream.
 */
export async function startStdio(
  connection: McpConnection,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<StdioServer> {
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= connection.close());

  // Both events: a pipe emits `end` then `close`, a destroyed stream only `close`. `close()` is
  // shared, so hearing both costs nothing.
  const ended = new Promise<void>((resolve) => {
    const onEnd = (): void => {
      // Settled either way: a close that failed has still ended the conversation.
      void close().then(resolve, () => {
        resolve();
      });
    };
    input.once('end', onEnd);
    input.once('close', onEnd);
  });

  await connection.server.connect(new StdioServerTransport(input, output));
  return { close, ended };
}
