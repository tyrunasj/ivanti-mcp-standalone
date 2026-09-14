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
 */
/**
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

export interface IvantiApiErrorInit {
  status: number;
  method: string;
  url: string;
  body?: string;
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

  constructor(init: IvantiApiErrorInit, message?: string) {
    super(message ?? `Ivanti ${init.method} ${init.status}`);
    this.name = 'IvantiApiError';
    this.status = init.status;
    this.method = init.method;
    this.url = init.url;
    this.body = truncate(init.body ?? '');
  }
}

export function truncate(body: string, maxBytes: number = ERROR_BODY_MAX_BYTES): string {
  if (Buffer.byteLength(body, 'utf8') <= maxBytes) return body;
  return `${body.slice(0, maxBytes)}… [truncated]`;
}

/**
 * Redacts the API key from an error body, then caps it.
 *
 * Ivanti echoes submitted values back in failures, and the ASMX session hands the key over as a
 * **body parameter** rather than a header — so a fault on that call is the realistic way the
 * credential ends up in a log line or in front of the model.
 *
 * Only the key itself, never a generic "key-shaped token" pass: Ivanti RecIds are 32-char hex and
 * the model needs to read them out of error text. `overlord-service` removed exactly such a pass
 * for that reason.
 */
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
 */
const SENSITIVE_FIELDS =
  /\\?"(SessionId|TenantId|LoginId|Hostname|ServiceName|ClientIpAddress)\\?"\s*:\s*\\?"[^"\\]*\\?"/gi;

export function scrubErrorBody(body: string, apiKey: string): string {
  const withoutKey = apiKey === '' ? body : body.split(apiKey).join('[REDACTED-API-KEY]');
  const withoutInternals = withoutKey.replace(SENSITIVE_FIELDS, (match, field: string) =>
    match.startsWith('\\') ? `\\"${field}\\":\\"[REDACTED]\\"` : `"${field}":"[REDACTED]"`,
  );
  return truncate(withoutInternals);
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
