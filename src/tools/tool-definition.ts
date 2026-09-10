import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * A tool with no input arguments.
 *
 * Tools are described as data rather than registered inline so that "what a tool is"
 * stays separate from "which tools this mode exposes" (see `register-tools.ts`).
 */
export interface ToolDefinition {
  name: string;
  config: {
    title: string;
    description: string;
    annotations: ToolAnnotations;
  };
  handler: () => CallToolResult;
}
