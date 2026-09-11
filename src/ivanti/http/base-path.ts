import { looksLikeCsdl } from '../metadata/csdl.js';
import { createIvantiRoutes } from '../odata/url.js';

/**
 * Ivanti tenants serve the API either under `/HEAT` or at the root, and which one is not
 * discoverable from anything but trying. Most tenants have the prefix; some do not.
 *
 * Probed once at startup rather than configured, because it is the kind of setting someone gets
 * wrong and then debugs as an authentication failure.
 */
export const BASE_PATH_CANDIDATES = ['/HEAT', ''] as const;

/**
 * Which CSDL form to ask for, in order.
 *
 * The document is served per *graph*, and the forms that exist vary by tenant. Measured live:
 * the service-root and `businessobject` forms answer `404 ISM_4004 "No service"`, while the
 * entity-scoped `incidents` graph answers the full related graph. `overlord-service` ended up
 * with the same ladder, so this is not one tenant's quirk.
 */
export const METADATA_GRAPHS: readonly (string | undefined)[] = [
  'incidents',
  undefined,
  'businessobject',
];

/**
 * Kept separate from the transport's timeout: this one runs before the process serves anything,
 * and an unreachable tenant must fail the startup rather than hang it. A container stuck part-way
 * through starting is harder to diagnose than one that exits.
 */
export const PROBE_TIMEOUT_MS = 10_000;

export type ProbeFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface BasePathProbe {
  basePath: string;
  /** The CSDL URL that answered — worth reusing rather than rediscovering. */
  metadataUrl: string;
  /** What was tried, in order — useful in the startup log and in the failure message. */
  attempted: { url: string; status: number | 'error' }[];
}

/**
 * Finds the base path by asking for `$metadata` under each candidate.
 *
 * `$metadata` is the right probe: it is authenticated, and its body is checkable — a 200 carrying
 * a login page would otherwise be taken as success and poison everything downstream.
 *
 * It must be asked for as **XML**: `Accept: application/json` turns the same URL into a 500,
 * because Ivanti tries to render CSDL as JSON and throws.
 */
export async function probeBasePath(
  baseUrl: string,
  apiKey: string,
  fetchImpl: ProbeFetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<BasePathProbe> {
  const attempted: BasePathProbe['attempted'] = [];

  for (const candidate of BASE_PATH_CANDIDATES) {
    for (const graph of METADATA_GRAPHS) {
      const url = createIvantiRoutes(baseUrl, candidate).metadata(graph);
      try {
        const response = await fetchImpl(url, {
          headers: {
            Authorization: `rest_api_key=${apiKey}`,
            Accept: 'application/xml',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        attempted.push({ url, status: response.status });
        if (response.ok && looksLikeCsdl(await response.text())) {
          return { basePath: candidate, metadataUrl: url, attempted };
        }
      } catch {
        attempted.push({ url, status: 'error' });
      }
    }
  }

  // A 401 is a different problem from a 404, and saying "could not reach" sends whoever reads it
  // to check DNS and firewalls when the tenant answered perfectly well and refused the key.
  const refused = attempted.find((a) => a.status === 401 || a.status === 403);
  if (refused !== undefined) {
    throw new Error(
      `Ivanti refused the API key: ${String(refused.status)} at ${refused.url}. The tenant is ` +
        'reachable, so check IVANTI_API_KEY (or IVANTI_API_KEY_FILE) rather than IVANTI_BASE_URL.',
    );
  }

  throw new Error(
    `Could not reach Ivanti OData under either base path. Tried:\n  ` +
      attempted.map((a) => `${String(a.status)} ${a.url}`).join('\n  ') +
      '\nCheck IVANTI_BASE_URL and that the API key is valid.',
  );
}
