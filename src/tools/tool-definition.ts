// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodRawShape } from 'zod';
import { ANONYMOUS, type CallerIdentity } from '../auth/identity.js';
import { createSessionPin, type SessionPin } from '../auth/identity-pin.js';
import type { ImpersonationSlot } from '../auth/impersonation.js';

/**
 * What a handler may know about the call it is serving.
 *
 * Threaded as an argument, never reachable from a global or from `process.env`: identity has two
 * sources — a verified token and a claim the caller made — and a handler that could reach for
 * either would be free to prefer the wrong one.
 */
export interface CallContext {
  readonly identity: CallerIdentity;
  /** Absent under stdio, which is one process and one conversation. */
  readonly sessionId?: string;
  /**
   * Who this conversation acts for, and the rules about changing that.
   *
   * Mutable where everything else here is not, and per conversation by construction: a server is
   * created per connection, so this object's lifetime is the session's. Created by
   * `registerTools` rather than by whoever built the context, so no transport can forget to.
   */
  readonly pin?: SessionPin;
  /**
   * The Ivanti session this conversation holds on the pinned person's behalf, when impersonation
   * is configured and reachable.
   *
   * Absent in the ordinary deployment, which is why every reader must check rather than assume:
   * `undefined` here is not a failure, it is the shape of a server without the ConfigDB pair.
   * Created per connection by the server factory, which also releases it when the connection
   * closes — the two belong together, so neither can be done without the other.
   */
  readonly impersonation?: ImpersonationSlot;
}

/** The arguments a handler receives, derived from its own input schema. */
export type ToolArgs<Shape extends ZodRawShape> = z.infer<z.ZodObject<Shape>>;

/**
 * A tool, described as data.
 *
 * Tools are data rather than inline `server.registerTool` calls so that "what a tool is" stays
 * separate from "which tools this mode exposes" (`register-tools.ts`) and from "which server
 * instance is being built" — definitions are created once and shared by every session.
 */
export interface ToolDefinition {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: ZodRawShape;
    annotations: ToolAnnotations;
  };
  /**
   * Erased to a plain bag of arguments: the SDK validates them against `inputSchema` before the
   * handler runs, and each handler is written against its own typed shape (see `defineTool`).
   */
  handler: (
    args: Record<string, unknown>,
    context?: CallContext,
  ) => CallToolResult | Promise<CallToolResult>;
}

export interface ToolSpec<Shape extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /**
   * Always explicit, never inferred. An unannotated tool defaults to destructive and open-world,
   * which is the opposite of what most of these are.
   */
  annotations: ToolAnnotations;
  /** `{}` for a tool that takes no arguments. */
  inputSchema: Shape;
  handler: (
    args: ToolArgs<Shape>,
    context: CallContext,
  ) => CallToolResult | Promise<CallToolResult>;
}

/**
 * Builds a definition whose handler is typed by its own schema.
 *
 * The generic is erased at the boundary so that a heterogeneous list of tools can be held in one
 * array — that cast lives here, once, rather than at every definition site.
 */
/**
 * What a handler sees when nobody supplied a context.
 *
 * The server always supplies one — `registerTools` binds it per session — so this is reached only
 * by a test calling a handler directly. Anonymous is the right default for that: it is the least
 * a handler can assume.
 */
function noContext(): CallContext {
  return { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
}

export function defineTool<Shape extends ZodRawShape>(spec: ToolSpec<Shape>): ToolDefinition {
  return {
    name: spec.name,
    config: {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: spec.annotations,
    },
    // A fresh pin per call when there is no context, so one test's identity cannot leak into
    // the next through a shared module-level object.
    handler: (args, context) => (spec.handler as ToolDefinition['handler'])(args, context ?? noContext()),
  };
}
