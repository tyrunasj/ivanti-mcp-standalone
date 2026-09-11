import type { Logger } from '../logger.js';
import { probeBasePath, type ProbeFetch } from './http/base-path.js';
import { createTransport, type FetchLike, type IvantiTransport } from './http/transport.js';
import { createMetadataCatalog, type MetadataCatalog } from './metadata/catalog.js';

export interface ConnectOptions {
  baseUrl: string;
  apiKey: string;
  logger: Logger;
  fetchImpl?: FetchLike & ProbeFetch;
  timeoutMs?: number;
}

export interface IvantiConnection {
  /** `/HEAT` or empty — whichever answered `$metadata`. */
  readonly basePath: string;
  /**
   * The CSDL URL that answered. Which of the three forms a tenant serves is a per-tenant fact
   * discovered at startup, so the metadata catalog reads it from here rather than walking the
   * same ladder again on its first fetch.
   */
  readonly metadataUrl: string;
  readonly transport: IvantiTransport;
  /** The tenant's schema, read through that CSDL document and cached for the process lifetime. */
  readonly metadata: MetadataCatalog;
}

/**
 * Everything between "there is an API key in the environment" and "there is a usable client".
 *
 * The base path is probed here, at startup, and once: it cannot change while the process runs,
 * and discovering it lazily would put a network round trip — and a new failure mode — inside
 * whichever tool call happened to be first.
 *
 * Throws when neither candidate answers. That is deliberate: a server configured for a tenant it
 * cannot reach should not come up and advertise Ivanti tools that are all going to fail.
 */
export async function connectIvanti(options: ConnectOptions): Promise<IvantiConnection> {
  const { baseUrl, apiKey, logger, fetchImpl = globalThis.fetch, timeoutMs } = options;

  const probe = await probeBasePath(baseUrl, apiKey, fetchImpl, timeoutMs);

  logger.info('ivanti reachable', {
    baseUrl,
    // An empty prefix is a real answer, and one a reader must not mistake for "unknown".
    basePath: probe.basePath === '' ? '(root)' : probe.basePath,
    attempts: probe.attempted.length,
  });

  const transport = createTransport({
    baseUrl,
    basePath: probe.basePath,
    apiKey,
    logger,
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  return {
    basePath: probe.basePath,
    metadataUrl: probe.metadataUrl,
    transport,
    metadata: createMetadataCatalog({ transport, seedUrl: probe.metadataUrl, logger }),
  };
}
