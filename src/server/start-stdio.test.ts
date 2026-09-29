// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { PassThrough } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { McpConnection } from './create-server.js';
import { startStdio } from './start-stdio.js';

/** A connection whose close takes a moment to hand the Ivanti session back, as a real one does. */
const slowConnection = (): { connection: McpConnection; released: () => boolean } => {
  let released = false;
  const server = new McpServer({ name: 'test', version: '0' });
  const close = vi.fn(async (): Promise<void> => {
    await server.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    released = true;
  });
  return { connection: { server, close }, released: () => released };
};

describe('startStdio', () => {
  /**
   * The SDK's transport listens for data and errors, never for the end of input. A client that
   * exited left the process to drain its event loop and die — with the person's Ivanti session
   * still open on the tenant, since nothing had closed the conversation.
   */
  it('closes the conversation when stdin ends, and settles only once it is released', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { connection, released } = slowConnection();
    const stdio = await startStdio(connection, input, output);

    input.end();
    await stdio.ended;

    expect(released()).toBe(true);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('closes once however many ways it is asked to', async () => {
    const input = new PassThrough();
    const { connection } = slowConnection();
    const stdio = await startStdio(connection, input, new PassThrough());

    // A SIGTERM arriving as the client exits is the ordinary way this happens.
    input.end();
    await stdio.ended;
    await Promise.all([stdio.close(), stdio.close()]);

    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  // stdout is the JSON-RPC stream: teardown must not say a word on it.
  it('writes nothing to the output while tearing down', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = vi.fn();
    output.on('data', written);
    const { connection } = slowConnection();
    const stdio = await startStdio(connection, input, output);

    input.end();
    await stdio.ended;

    expect(written).not.toHaveBeenCalled();
  });
});
