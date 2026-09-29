// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { createHash } from 'node:crypto';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { ToolDefinition } from './tool-definition.js';

export interface ManifestFingerprint {
  /** Changes when any description, argument or the instructions change — and only then. */
  manifest: string;
  /** What every request re-sends: the tools as a model is handed them, plus the instructions. */
  manifestChars: number;
}

/**
 * Which instructions a usage line was produced under, and what they cost per request.
 *
 * Stamped on every `tool finished` line so the report can put two versions side by side: the
 * question "did that description change reduce failed calls" is answered by grouping on this.
 *
 * The schemas are converted exactly as the SDK's `tools/list` converts them — the same function,
 * the same options — so the size is what clients receive, and close to `pnpm manifest:size`'s
 * per-request figure for the same deployment. The SDK is pinned; an upgrade that changed these
 * options would show here as a new fingerprint, which is the honest answer.
 */
export function fingerprintManifest(
  tools: readonly ToolDefinition[],
  instructions: string | undefined,
): ManifestFingerprint {
  const sent = tools.map((tool) => {
    const schema = normalizeObjectSchema(tool.config.inputSchema);
    return {
      name: tool.name,
      description: tool.config.description,
      input_schema:
        schema === undefined
          ? { type: 'object', properties: {} }
          : toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' }),
    };
  });
  const text = JSON.stringify(sent) + (instructions ?? '');
  return {
    manifest: createHash('sha256').update(text).digest('hex').slice(0, 12),
    manifestChars: text.length,
  };
}
