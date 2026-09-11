import { IvantiApiError } from '../http/errors.js';

/** One Ivanti record, as it arrives: a bag of fields whose shape is the tenant's business. */
export type OdataRecord = Record<string, unknown>;

/**
 * What Ivanti answers for a navigation property with nothing on the other side: a 200 whose
 * `value` is this **string** rather than an empty array. `res.value.length` is then 19, and
 * `res.value[0]` is `"N"`.
 */
const NO_INSTANCES = /^\s*no instances found\.?\s*$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads an OData collection out of whatever Ivanti actually sent.
 *
 * Ivanti has **three** encodings for "no rows", measured live on a tenant:
 *
 * | Request | Answer |
 * |---|---|
 * | Entity set, `$filter` matches nothing | 200 with a **completely empty body** |
 * | Navigation property, nothing related | 200, `{"value": "No instances found."}` |
 * | Anything with rows | 200, `{"value": [ … ]}` |
 *
 * The first two are the dangerous ones: the empty body parses to `undefined`, and the sentinel is
 * a string that answers `.length` and `[0]` without complaint. Every collection read goes through
 * here so that neither can reach a tool as a row.
 *
 * An unrecognised string is an **error**, not an empty result. Ivanti has a habit of putting
 * prose where data belongs, and swallowing it would mean reporting "no rows" for what might be
 * "access denied" — principle 1: never report success from a 200.
 */
export function readCollection<T>(payload: unknown, url: string): T[] {
  // An empty body: the transport already turned it into `undefined`.
  if (payload === undefined || payload === null) return [];

  if (!isObject(payload)) {
    throw new IvantiApiError(
      { status: 200, method: 'GET', url, body: JSON.stringify(payload) },
      `Ivanti answered 200 with ${typeof payload} where a collection was expected`,
    );
  }

  const { value } = payload;

  if (Array.isArray(value)) return value as T[];

  if (typeof value === 'string') {
    if (NO_INSTANCES.test(value)) return [];
    throw new IvantiApiError(
      { status: 200, method: 'GET', url, body: value },
      `Ivanti answered 200 with the message "${value}" where a collection was expected`,
    );
  }

  throw new IvantiApiError(
    { status: 200, method: 'GET', url, body: JSON.stringify(payload).slice(0, 200) },
    'Ivanti answered 200 with a body that has no "value" collection',
  );
}
