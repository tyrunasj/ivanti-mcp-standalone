// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { createHash, randomBytes } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Per process and never logged, so an `argsHash` cannot be reversed by hashing likely names and
 * comparing. It only has to make two identical calls in one conversation look identical.
 */
const SALT = randomBytes(16);

export interface CallSize {
  /** The arguments as the model wrote them — output tokens, the dearest kind. */
  argsChars: number;
  /**
   * The same for the same arguments, whatever their key order — so a repeated identical call is
   * visible without the arguments ever being written down.
   */
  argsHash: string;
  /** The text the model reads back, and keeps re-reading on every later turn. */
  resultChars: number;
  /** An image or other non-text block, which a model does not read as text; counted apart. */
  nonTextChars?: number;
}

/**
 * How much one call put into the conversation, in characters.
 *
 * Characters rather than tokens: this server serves any model and every vendor tokenizes
 * differently, so a token count would be exact for one family and wrong for the rest. Sizes only —
 * never the text, which is ticket content and names.
 */
export function callSize(args: unknown, result: CallToolResult | undefined): CallSize {
  let resultChars = 0;
  let nonTextChars = 0;
  for (const block of result?.content ?? []) {
    if (block.type === 'text') resultChars += block.text.length;
    else nonTextChars += JSON.stringify(block).length;
  }
  return {
    argsChars: JSON.stringify(args ?? {}).length,
    argsHash: createHash('sha256')
      .update(SALT)
      .update(canonical(args ?? {}))
      .digest('base64url')
      .slice(0, 12),
    resultChars,
    ...(nonTextChars === 0 ? {} : { nonTextChars }),
  };
}

/** JSON with every object's keys sorted, so `{a, b}` and `{b, a}` hash alike. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
