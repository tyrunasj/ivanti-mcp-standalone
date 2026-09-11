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
const NOT_FOUND_PATTERNS = [/ISM_4000/i, /invalid key/i, /not found/i, /does not exist/i];

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
export function scrubErrorBody(body: string, apiKey: string): string {
  const redacted = apiKey === '' ? body : body.split(apiKey).join('[REDACTED-API-KEY]');
  return truncate(redacted);
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
