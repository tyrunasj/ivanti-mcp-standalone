// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/** Four characters per group, then an optionally padded tail: the whole of standard base64. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * A base64 argument as bytes, or undefined when it is not base64.
 *
 * `Buffer.from(text, 'base64')` never throws and stops at the first character it cannot decode,
 * so `aGVsbG8=!!!d29ybGQ=` came back as `hello` — a truncated file, uploaded and reported as
 * attached. This checks the whole text before decoding any of it.
 *
 * Deliberate tolerances: ASCII whitespace anywhere (a model wraps lines), and missing `=` padding
 * (trimmed by the same habit; the decode is exact without it). Deliberate refusals: the url-safe
 * alphabet (`-`, `_`), which is a different encoding and would decode wrong, and a `data:` URL
 * prefix, which is not part of the value.
 *
 * Empty input decodes to an empty buffer; whether that is acceptable is the caller's call.
 */
export function decodeBase64Argument(text: string): Buffer | undefined {
  const compact = text.replace(/[\t\n\f\r ]+/g, '');
  const padded =
    compact.length % 4 === 0 || compact.includes('=')
      ? compact
      : compact + '='.repeat(4 - (compact.length % 4));
  if (!BASE64.test(padded)) return undefined;
  return Buffer.from(padded, 'base64');
}

/** Said wherever a base64 argument is refused, so the cause is named once. */
export const NOT_BASE64 =
  'is not valid base64 — it must be the bare standard-alphabet encoding of the whole file, with no ' +
  '`data:` prefix';
