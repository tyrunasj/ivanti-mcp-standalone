// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { IncomingMessage } from 'node:http';

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * What an `initialize` may weigh. It is read before a session exists, and it is a few hundred
 * bytes of client info and capabilities; the 4 MiB belongs to `tools/call` on an admitted session.
 */
export const MAX_INITIALIZE_BODY_BYTES = 64 * 1024;

/** Bytes of request bodies buffered at once, across every socket, before new ones are turned away. */
export const MAX_BUFFERED_BODY_BYTES = 64 * 1024 * 1024;

/** Request bodies one socket may be sending at once; a client pipelining past this is not a client. */
export const MAX_BODIES_PER_SOCKET = 4;

/** How long a refused body is told to wait; the budget frees as soon as any read finishes. */
export const BODY_RETRY_AFTER_SECONDS = 1;

export type BodyResult =
  | { ok: true; body: unknown }
  | { ok: false; status: 400 | 413; message: string }
  | { ok: false; status: 503; message: string; retryAfterSeconds: number };

/** Stands in for the socket of a request that has none. */
const NO_SOCKET = {};

/**
 * A process-wide ceiling on request bytes held in memory, plus a per-socket cap on concurrent reads.
 *
 * Each body used to be buffered up to 4 MiB on its own, with nothing bounding how many at once —
 * and before a session was admitted — so a few hundred sockets each trickling a body could outgrow
 * the container's memory limit. Charged as chunks arrive, not reserved up front, so a small body
 * costs what it weighs.
 */
export class BodyBudget {
  private buffered = 0;
  private readonly bySocket = new WeakMap<object, number>();

  constructor(
    private readonly maxBytes: number = MAX_BUFFERED_BODY_BYTES,
    private readonly maxPerSocket: number = MAX_BODIES_PER_SOCKET,
  ) {}

  /** Bytes held now, for tests. */
  get held(): number {
    return this.buffered;
  }

  /** Starts a read on this socket; the returned function ends it. Undefined at the per-socket cap. */
  open(socket: object | undefined): (() => void) | undefined {
    // A request with no socket (a fake, a closed connection) counts against one shared key.
    socket ??= NO_SOCKET;
    const open = this.bySocket.get(socket) ?? 0;
    if (open >= this.maxPerSocket) return undefined;
    this.bySocket.set(socket, open + 1);
    return (): void => {
      this.bySocket.set(socket, Math.max(0, (this.bySocket.get(socket) ?? 1) - 1));
    };
  }

  /** Takes bytes from the budget; false, taking nothing, when there are not that many left. */
  charge(bytes: number): boolean {
    if (this.buffered + bytes > this.maxBytes) return false;
    this.buffered += bytes;
    return true;
  }

  release(bytes: number): void {
    this.buffered = Math.max(0, this.buffered - bytes);
  }
}

const busy = (message: string): BodyResult => ({
  ok: false,
  status: 503,
  message,
  retryAfterSeconds: BODY_RETRY_AFTER_SECONDS,
});

/**
 * Reads and parses a JSON request body.
 *
 * The body has to be read here rather than handed straight to the transport, because routing
 * depends on its content: a POST with no session header is only legitimate when it is an
 * `initialize` request. The parsed value is then passed through, so it is never read twice.
 *
 * With a `budget`, the bytes buffered are held against it until the read ends, and a request
 * that would exceed it — or that arrives on a socket already sending its quota — is answered 503
 * instead of being buffered.
 */
export async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
  budget?: BodyBudget,
): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;

  const closeSlot = budget?.open(request.socket);
  if (budget !== undefined && closeSlot === undefined) {
    return busy('Too many request bodies in flight on this connection');
  }

  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      if (total + buffer.length > maxBytes) {
        return { ok: false, status: 413, message: 'Request body too large' };
      }
      if (budget !== undefined && !budget.charge(buffer.length)) {
        return busy('The server is buffering too many request bodies; retry shortly');
      }
      total += buffer.length;
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, status: 400, message: 'Could not read request body' };
  } finally {
    budget?.release(total);
    closeSlot?.();
  }

  if (total === 0) return { ok: true, body: undefined };

  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'Request body is not valid JSON' };
  }
}
