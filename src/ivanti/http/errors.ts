// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/** Ivanti error bodies can be large and echo submitted values; cap what we keep. */
const ERROR_BODY_MAX_BYTES = 1024;

/**
 * Ivanti's own not-found dialect.
 *
 * **Ivanti has no 404 for lookups.** A get-by-key on a record that does not exist answers
 * `400 ISM_4000 "Invalid key"` — the *same* code it uses for a field name that does not exist —
 * and `/rest/Attachment` answers `400` with "not found" in the body. Callers that treat 404 as
 * "absent" and 400 as "my request was wrong" get both cases backwards, so the dialect is
 * encoded here once rather than re-derived at each call site.
 *
 * `ISM_4000` on its own is NOT one of these, though it once was.
 *
 * It is Ivanti's code for "invalid request payload" generally — a missing record answers it with
 * `"Invalid key"`, and a *refused workflow transition* answers the same code with
 * `DataLayer.PromptException`. Matching the bare code made every prompt-gated status change report
 * itself as "the record or field does not exist", which sent two independent testers hunting for
 * a field name that was never wrong. The body has to actually say the record is absent.
 */
const NOT_FOUND_PATTERNS = [/invalid key/i, /not found/i, /does not exist/i];

/**
 * Ivanti refused the *transition*, not the request: the field and value are valid and the record
 * is there, but the change is gated behind a prompt the API cannot answer. It arrives as
 * `ISM_4000 / Invalid Request Payload` carrying `DataLayer.PromptException`.
 */
export function isIvantiPromptRefusal(error: unknown): boolean {
  return error instanceof IvantiApiError && /PromptException/i.test(error.body);
}

/**
 * Which credential a request carried: the API key's own account, or a person's session.
 *
 * It matters for a 401 alone. A person's session dies without saying so and is worth re-opening;
 * the service account's key being refused is a different failure, and re-opening the person's
 * session over it throws away a session that was fine.
 */
export type IvantiCredential = 'service' | 'person';

export interface IvantiApiErrorInit {
  status: number;
  method: string;
  url: string;
  body?: string;
  credential?: IvantiCredential;
  /**
   * Why Ivanti never answered, as a code — `ENOTFOUND`, `ECONNRESET`, `CERT_HAS_EXPIRED`,
   * `UND_ERR_SOCKET`, `TimeoutError`. Status 0 only. A code names no person and no query, so it
   * may go where the body may not: the `warn` line an operator reads without turning on debug.
   */
  code?: string;
}

export class IvantiApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  /**
   * Size-capped here; the API key is redacted by `scrubErrorBody` in the transport, which is the
   * only layer that knows it. Ivanti error bodies echo what was submitted.
   */
  readonly body: string;
  readonly code: string | undefined;
  /** Which credential the request carried; unset where a caller built the error itself. */
  readonly credential: IvantiCredential | undefined;

  constructor(init: IvantiApiErrorInit, message?: string) {
    super(message ?? `Ivanti ${init.method} ${init.status}`);
    this.name = 'IvantiApiError';
    this.status = init.status;
    this.method = init.method;
    this.url = init.url;
    this.body = truncate(init.body ?? '');
    this.code = init.code;
    this.credential = init.credential;
  }

  /**
   * The shape it takes in a log line — the path, never the URL.
   *
   * Without this, `JSON.stringify` wrote every own field, `url` among them, so an error passed to
   * the logger carried its whole `$filter` — a person's name, typically — into an `info` or `warn`
   * line. The query belongs in the debug request line and nowhere else.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      method: this.method,
      path: pathOf(this.url),
      body: this.body,
      ...(this.code === undefined ? {} : { code: this.code }),
    };
  }
}

/**
 * Ivanti answered, and the answer is bigger than the caller agreed to hold.
 *
 * Not an `IvantiApiError`: nothing failed and nothing was refused, so reporting it as one would
 * tell the model "Ivanti refused the request (200)". The body was never read past the cap — that
 * is the point of it: an attachment of any size used to be read whole into memory first.
 */
export class ResponseTooLargeError extends Error {
  readonly url: string;
  readonly maxBytes: number;
  /** What `Content-Length` declared, when it did; otherwise the read stopped at the cap. */
  readonly declaredBytes: number | undefined;

  constructor(url: string, maxBytes: number, declaredBytes?: number) {
    super(
      (declaredBytes === undefined
        ? `The file is larger than ${formatBytes(maxBytes)}`
        : `The file is ${formatBytes(declaredBytes)}, over ${formatBytes(maxBytes)}`) +
        ' — the most this server reads into a conversation — so it was not downloaded. Tell the ' +
        'person its name and offer to open it in Ivanti instead.',
    );
    this.name = 'ResponseTooLargeError';
    this.url = url;
    this.maxBytes = maxBytes;
    this.declaredBytes = declaredBytes;
  }

  /** The path, never the URL — the same rule `IvantiApiError` keeps. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      path: pathOf(this.url),
      maxBytes: this.maxBytes,
      ...(this.declaredBytes === undefined ? {} : { declaredBytes: this.declaredBytes }),
    };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The path without the query string, for logs. Falls back to nothing rather than throwing. */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/**
 * Caps a body at `maxBytes` of UTF-8. The cap is in bytes, so the cut is made in bytes: slicing
 * UTF-16 units kept up to three times the cap for a non-Latin body. The cut backs off to a
 * character boundary rather than leaving half a character behind.
 */
export function truncate(body: string, maxBytes: number = ERROR_BODY_MAX_BYTES): string {
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.length <= maxBytes) return body;
  let end = maxBytes;
  // A continuation byte (10xxxxxx) cannot start a character, so the cut would split one.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}… [truncated]`;
}

/**
 * Session internals Ivanti volunteers in an unhandled-exception body.
 *
 * A 500 from `PreDeleteObject` came back carrying `SessionId`, `TenantId`, `LoginId`,
 * `Hostname` and `ServiceName` — infrastructure detail about the deployment, handed to whoever
 * called the tool, in an error the caller could do nothing with. The API key was the only thing
 * being redacted because it was the only thing anyone had thought to look for; these turned up
 * by driving the tools until something threw.
 *
 * Only the *value* is replaced, so the shape of the error is still readable and the RecIds a
 * caller needs from an error body are untouched.
 *
 * The escaped forms matter: Ivanti nests the whole logging context inside a JSON **string**, so
 * the fields arrive as `\\"SessionId\\":\\"…\\"` rather than `"SessionId":"…"`. A first pass at
 * this matched only the unescaped form and redacted exactly one of the five — which is why the
 * leak survived a round of testing and was found again.
 *
 * It was found a third time, because that fix matched the two spellings it had been shown rather
 * than the thing they were spellings OF. A quote arrives encoded by however many layers it passed
 * through: escaped once or twice by JSON-in-a-string nesting (`\"`, `\\\"`), as an HTML entity —
 * Ivanti's OData 500 is `Unhandled system exception: {&quot;error&quot;…}` — or as the unicode
 * escape .NET serialisers write for `"`. So the delimiter is a CLASS of tokens, and the closing
 * quote must be the same token as the opening one.
 */
// Escaping depth and entity repetition are bounded: unbounded `\\*` and `(?:amp;)*` make a long run
// of backslashes or `&amp;amp;…` quadratic, because every offset inside the run starts a scan to
// its end. No real body nests this deep.
const MAX_ESCAPES = 32;
const MAX_AMP = 8;
const QUOTE = String.raw`\\{0,${MAX_ESCAPES}}(?:"|&(?:amp;){0,${MAX_AMP}}(?:quot|#0*34|#x0*22);)|\\{1,${MAX_ESCAPES}}u0022`;

const SENSITIVE_FIELD_NAMES =
  'SessionId|SessionKey|ConnectionString|TenantId|LoginId|Hostname|ServiceName|ClientIpAddress';

// Only the OPENER is a regex: `"SessionId":"` in any of the quote spellings. Where the value ends
// is found by `fieldValueEnd`, a linear scan. A single regex with a lazy `[\s\S]*?` to the closer
// was quadratic on an unbounded body that Ivanti echoes, so one caller could stall every session.
const SENSITIVE_FIELD_OPENERS = new RegExp(
  String.raw`(${QUOTE})(${SENSITIVE_FIELD_NAMES})\1\s*:\s*\1`,
  'gi',
);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where a field's value ends: the first closing quote token that is not itself escaped.
 *
 * The value admits anything, so a domain-qualified login (`\"LoginId\":\"CORP\\\\jsmith\"`) is
 * redacted whole. A quote is the closer when the backslashes before it number the token's own
 * leading backslashes plus an even count; an odd extra backslash means the quote belongs to the
 * value. Returns the end of the body when there is no closer: an opener with no closer must not
 * leave its value behind, so the rest of the body is the value.
 */
function fieldValueEnd(body: string, from: number, quote: string): number {
  const own = /^\\*/.exec(quote)?.[0].length ?? 0;
  const token = quote.slice(own);
  const finder = new RegExp(escapeRegExp(token), 'gi');
  finder.lastIndex = from;
  for (let hit = finder.exec(body); hit !== null; hit = finder.exec(body)) {
    let backslashes = 0;
    while (hit.index - backslashes - 1 >= from && body[hit.index - backslashes - 1] === '\\') {
      backslashes += 1;
    }
    if (backslashes >= own && (backslashes - own) % 2 === 0) return hit.index + token.length;
    if (hit[0] === '') finder.lastIndex += 1;
  }
  return body.length;
}

/**
 * The same fields again, as XML elements.
 *
 * CentralConfig answers XML rather than JSON, and `ConnectionString` there carries the tenant's
 * **database credentials, password included** — by a wide margin the most sensitive thing any
 * Ivanti surface returns. A JSON-shaped pattern matches none of it.
 *
 * Its brackets come in the same variety the quotes do — `&lt;` when an HTML error page quotes the
 * XML, `<` when a JSON body does — and the closing tag is spelled like the opening one.
 */
const OPEN_BRACKET = String.raw`<|&(?:amp;){0,${MAX_AMP}}(?:lt|#0*60|#x0*3c);|\\{1,${MAX_ESCAPES}}u003c`;
const CLOSE_BRACKET = String.raw`>|&(?:amp;){0,${MAX_AMP}}(?:gt|#0*62|#x0*3e);|\\{1,${MAX_ESCAPES}}u003e`;
const SENSITIVE_ELEMENT_NAMES =
  '(?:DB)?ConnectionString|SessionId|SessionKey|PrimaryEncryptionKey|SecondaryKeyParams|' +
  'TenantId|LoginId|Hostname|ServiceName|ClientIpAddress';
const SENSITIVE_ELEMENT_OPENERS = new RegExp(
  String.raw`(${OPEN_BRACKET})(${SENSITIVE_ELEMENT_NAMES})(${CLOSE_BRACKET})`,
  'gi',
);

/** Where an element's closing tag ends, or the end of the body when it has none (see above). */
function elementEnd(body: string, from: number, open: string, element: string, close: string): number {
  const closer = new RegExp(
    `${escapeRegExp(open)}\\\\{0,${String(MAX_ESCAPES)}}\\/${escapeRegExp(element)}${escapeRegExp(close)}`,
    'gi',
  );
  closer.lastIndex = from;
  const hit = closer.exec(body);
  return hit === null ? body.length : hit.index + hit[0].length;
}

/** Replaces each match of `openers` with `redact(...)`, consuming through the value's end. */
function redactSpans(
  body: string,
  openers: RegExp,
  endOf: (match: RegExpExecArray) => number,
  redact: (match: RegExpExecArray) => string,
): string {
  openers.lastIndex = 0;
  let out = '';
  let copied = 0;
  for (let match = openers.exec(body); match !== null; match = openers.exec(body)) {
    const end = endOf(match);
    out += body.slice(copied, match.index) + redact(match);
    copied = end;
    openers.lastIndex = end;
  }
  return out + body.slice(copied);
}

/**
 * Every spelling of a credential worth looking for. A SID is `tenant#guid#n`, and echoed back
 * inside a URL it arrives percent-encoded, which the plain string never matches.
 */
const spellingsOf = (secret: string): string[] =>
  secret === '' ? [] : [...new Set([secret, encodeURIComponent(secret)])];

/**
 * Redacts every credential the call carried — the API key, a session SID — then caps the body.
 *
 * Ivanti echoes submitted values back in failures, and the ASMX session hands the key over as a
 * **body parameter** rather than a header — so a fault on that call is the realistic way the
 * credential ends up in a log line or in front of the model.
 *
 * Only the key itself, never a generic "key-shaped token" pass: Ivanti RecIds are 32-char hex and
 * the model needs to read them out of error text. `overlord-service` removed exactly such a pass
 * for that reason.
 */
export function scrubErrorBody(body: string, ...secrets: string[]): string {
  const withoutKey = secrets
    .flatMap(spellingsOf)
    .reduce((text, secret) => text.split(secret).join('[REDACTED-API-KEY]'), body);
  const withoutInternals = redactSpans(
    withoutKey,
    SENSITIVE_FIELD_OPENERS,
    (match) => fieldValueEnd(withoutKey, match.index + match[0].length, match[1] ?? ''),
    (match) => `${match[1] ?? ''}${match[2] ?? ''}${match[1] ?? ''}:${match[1] ?? ''}[REDACTED]${match[1] ?? ''}`,
  );
  const withoutElements = redactSpans(
    withoutInternals,
    SENSITIVE_ELEMENT_OPENERS,
    (match) =>
      elementEnd(withoutInternals, match.index + match[0].length, match[1] ?? '', match[2] ?? '', match[3] ?? ''),
    (match) =>
      `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}[REDACTED]${match[1] ?? ''}/${match[2] ?? ''}${match[3] ?? ''}`,
  );
  return truncate(withoutElements);
}

/**
 * Whether a failure means "the thing is not there", in Ivanti's dialect.
 *
 * Deliberately narrow: it matches the *body*, not just the status, because a bare 400 from
 * Ivanti is far more often a malformed request than a missing record.
 */
export function isIvantiNotFound(error: unknown): boolean {
  if (!(error instanceof IvantiApiError)) return false;
  if (error.status === 404) return true;
  if (error.status !== 400) return false;
  return NOT_FOUND_PATTERNS.some((pattern) => pattern.test(error.body));
}
