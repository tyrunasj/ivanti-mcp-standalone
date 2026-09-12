import { buildQuery, quoteOdataString, withQuery } from './odata/query.js';
import { readCollection, type OdataRecord } from './odata/response.js';
import type { IvantiTransport } from './http/transport.js';

/**
 * How this tenant spells the object name in a `ParentLink_Category`.
 *
 * CSDL reports an object lowercase (`incident`) while records hold it mixed-case (`Incident`), and
 * Ivanti resolves the link either way — a lowercase category is found by the relationship exactly
 * as a mixed-case one is (measured). So this is not a correctness fix, it is a tidiness one:
 * writing `incident` into a column whose every other row says `Incident` leaves the customer's own
 * reports grouping one record separately for ever.
 *
 * `eq` is case-insensitive here, so one filtered read finds a row whatever the casing and the row
 * states the spelling. Cached per transport — one process serves one tenant, and a `WeakMap` keeps
 * a test's fixture from answering for the next one.
 */
const spellings = new WeakMap<IvantiTransport, Map<string, Promise<string>>>();

export async function tenantCategorySpelling(
  transport: IvantiTransport,
  /** The child entity set to sample — `attachments`, `journal__notess`. */
  childEntitySet: string,
  category: string,
): Promise<string> {
  let perTenant = spellings.get(transport);
  if (perTenant === undefined) {
    perTenant = new Map();
    spellings.set(transport, perTenant);
  }

  const key = `${childEntitySet}:${category.toLowerCase()}`;
  let found = perTenant.get(key);
  if (found === undefined) {
    found = (async (): Promise<string> => {
      const url = withQuery(
        transport.routes.entitySet(childEntitySet),
        buildQuery({ filter: `ParentLink_Category eq ${quoteOdataString(category)}`, top: 1 }),
      );
      try {
        const rows = readCollection<OdataRecord>(await transport.request<OdataRecord>(url), url);
        const seen = rows[0]?.['ParentLink_Category'];
        return typeof seen === 'string' && seen.trim() !== '' ? seen.trim() : category;
      } catch {
        // A tenant with none of these yet has nothing to copy; its first one sets the precedent.
        return category;
      }
    })();
    perTenant.set(key, found);
  }
  return found;
}
