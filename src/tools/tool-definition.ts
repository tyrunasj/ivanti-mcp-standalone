import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodRawShape } from 'zod';
import { ANONYMOUS, type CallerIdentity } from '../auth/identity.js';

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
const NO_CONTEXT: CallContext = { identity: ANONYMOUS };

export function defineTool<Shape extends ZodRawShape>(spec: ToolSpec<Shape>): ToolDefinition {
  return {
    name: spec.name,
    config: {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: spec.annotations,
    },
    handler: (args, context = NO_CONTEXT) =>
      (spec.handler as ToolDefinition['handler'])(args, context),
  };
}
