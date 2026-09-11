import type { Logger } from '../logger.js';
import { probeBasePath, type ProbeFetch } from './http/base-path.js';
import { createTransport, type FetchLike, type IvantiTransport } from './http/transport.js';
import { createMetadataCatalog, type MetadataCatalog } from './metadata/catalog.js';
import { createSession, type IvantiSession } from './session/asmx-session.js';
import { probeCapability, type Capability, type CapabilityTier } from './session/capability.js';
import { createAdminCatalog, type AdminCatalog } from './session/admin-catalog.js';
import { createFormContext, type FormContext } from './session/form-context.js';
import { createWorkspaceCatalog, type WorkspaceCatalog } from './session/workspaces.js';

export interface ConnectOptions {
  baseUrl: string;
  apiKey: string;
  /** Refuses to use more than this, whatever the credential can do. */
  maxTier?: CapabilityTier;
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
  /** The ASMX half — a separate credential, established lazily and shared. */
  readonly session: IvantiSession;
  /** The role's own workspaces: display names for the objects people actually work in. */
  readonly workspaces: WorkspaceCatalog;
  /** The complete catalog, when the key's role can reach the admin console. */
  readonly admin: AdminCatalog;
  /** Create forms, which are the only session-reachable source of a field's allowed values. */
  readonly forms: FormContext;
  /**
   * What this credential turned out to be able to do. Decided at startup because tools are
   * selected once: a tool that cannot work here should not exist rather than fail when called.
   */
  readonly capability: Capability;
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
  const { baseUrl, apiKey, logger, fetchImpl = globalThis.fetch, timeoutMs, maxTier } = options;

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

  const session = createSession({
    baseUrl,
    routes: transport.routes,
    apiKey,
    logger,
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  const admin = createAdminCatalog(session, logger);
  const workspaces = createWorkspaceCatalog(session, logger);

  // Probed here, not on first use: which tools exist depends on the answer, and tools are
  // selected once at startup.
  const capability = await probeCapability(session, admin, logger, maxTier);

  return {
    basePath: probe.basePath,
    metadataUrl: probe.metadataUrl,
    transport,
    metadata: createMetadataCatalog({
      transport,
      seedUrl: probe.metadataUrl,
      logger,
      // "Did you mean" should reach as far as the credential does.
      suggestionNames:
        capability.tier === 'admin'
          ? async (): Promise<string[]> => (await admin.list()).map((object) => object.object)
          : undefined,
    }),
    session,
    workspaces,
    admin,
    forms: createFormContext(session, workspaces, logger),
    capability,
  };
}
