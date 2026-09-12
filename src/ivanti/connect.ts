import type { Logger } from '../logger.js';
import { probeBasePath, type ProbeFetch } from './http/base-path.js';
import { createTransport, type FetchLike, type IvantiTransport } from './http/transport.js';
import { createMetadataCatalog, type MetadataCatalog } from './metadata/catalog.js';
import { createSession, type IvantiSession } from './session/asmx-session.js';
import { probeCapability, type Capability, type CapabilityTier } from './session/capability.js';
import { createAdminCatalog, type AdminCatalog } from './session/admin-catalog.js';
import { createFormContext, type FormContext } from './session/form-context.js';
import { createWorkspaceCatalog, type WorkspaceCatalog } from './session/workspaces.js';
import { createPersonDirectory, type PersonDirectory } from './people/directory.js';
import { createCustomerLinks, type CustomerLinks } from './people/customer-link.js';
import {
  createTenantOffsetReader,
  type TenantOffsetReader,
} from './service-request/tenant-offset.js';

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
   * Resolving a person, and finding the field that ties a record to one.
   *
   * On the `rest_api_key` surface rather than the session, so `enduser` mode works for a
   * credential that cannot open an ASMX session at all — which is most customers' keys.
   */
  readonly people: {
    readonly directory: PersonDirectory;
    readonly customerLinks: CustomerLinks;
  };
  readonly serviceRequests: {
    /**
     * The tenant's UTC offset, which a submitted datetime is converted from and which no
     * endpoint states. Read lazily: without a date parameter it changes nothing.
     */
    readonly tenantOffset: TenantOffsetReader;
  };
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

  const metadata = createMetadataCatalog({
    transport,
    seedUrl: probe.metadataUrl,
    logger,
    // "Did you mean" should reach as far as the credential does.
    suggestionNames:
      capability.tier === 'admin'
        ? async (): Promise<string[]> => (await admin.list()).map((object) => object.object)
        : undefined,
  });

  const directory = createPersonDirectory({ transport, metadata, logger });

  return {
    basePath: probe.basePath,
    metadataUrl: probe.metadataUrl,
    transport,
    metadata,
    session,
    workspaces,
    admin,
    forms: createFormContext(session, workspaces, logger),
    serviceRequests: { tenantOffset: createTenantOffsetReader(transport, logger) },
    people: {
      directory,
      customerLinks: createCustomerLinks({
        transport,
        personObjects: directory.personObjects,
        logger,
      }),
    },
    capability,
  };
}
