import { vi } from 'vitest';
import type { IvantiConnection } from './connect.js';
import { IvantiApiError } from './http/errors.js';
import type { IvantiTransport } from './http/transport.js';
import { UnknownEntityError, type MetadataCatalog } from './metadata/catalog.js';
import type { IvantiSession, SessionIdentity } from './session/asmx-session.js';
import { createAdminCatalog } from './session/admin-catalog.js';
import type { Capability } from './session/capability.js';
import { createFormContext } from './session/form-context.js';
import { createWorkspaceCatalog } from './session/workspaces.js';
import { createPersonDirectory } from './people/directory.js';
import { createCustomerLinks } from './people/customer-link.js';
import type { EntityField, EntityMetadata } from './metadata/csdl.js';
import { createLogger } from '../logger.js';
import { createIvantiRoutes } from './odata/url.js';

/**
 * A connection that answers from fixtures instead of a tenant.
 *
 * Tool tests care about what a tool does with an answer, not about how the answer travelled, so
 * this stubs the whole Ivanti layer: `responses` is matched by URL substring, in declaration
 * order, and an unmatched URL is the empty body Ivanti sends for a query that matches nothing.
 */
export interface ConnectionFixtureOptions {
  /** Keyed by lowercase CSDL entity name. */
  entities?: Record<string, Partial<EntityMetadata>>;
  /**
   * URL fragment → parsed payload, or an Error to throw. A key may be prefixed with a method
   * (`'POST incidents'`) when a write and a read share a URL, which they do for a collection.
   */
  responses?: Record<string, unknown>;
  /** Defaults to the OData tier: no session, as a customer with an analyst key would run. */
  capability?: Capability;
  /** ASMX answers, keyed by `<service>/<method>` fragment. */
  sessionCalls?: Record<string, unknown>;
}

export interface ConnectionFixture {
  connection: IvantiConnection;
  /** Every URL the tools asked for, in order. */
  urls: string[];
}

export function field(name: string, overrides: Partial<EntityField> = {}): EntityField {
  return {
    name,
    type: 'Edm.String',
    nullable: true,
    validated: false,
    internalTwin: false,
    ...overrides,
  };
}

export function entityFixture(name: string, overrides: Partial<EntityMetadata> = {}): EntityMetadata {
  return { name, fields: [field('RecId'), field('Subject')], relationships: [], ...overrides };
}

const fixtureLogger = createLogger('error', () => undefined);

export function connectionFixture(options: ConnectionFixtureOptions = {}): ConnectionFixture {
  const urls: string[] = [];
  const routes = createIvantiRoutes('https://tenant.example', '/HEAT');

  const entities = new Map<string, EntityMetadata>(
    Object.entries(options.entities ?? {}).map(([name, overrides]) => [
      name.toLowerCase(),
      entityFixture(name, overrides),
    ]),
  );

  // Mutable so a DELETE can actually make a record stop existing: a tool that verifies its own
  // delete would otherwise fail against a fixture that answers for ever.
  const responses = new Map(Object.entries(options.responses ?? {}));

  const answer = (url: string, method = 'GET'): unknown => {
    urls.push(`${method} ${url}`);
    const entries = [...responses.entries()];
    // A method-qualified key wins over a bare one, so a POST can differ from the GET beside it.
    const match =
      entries.find(([key]) => key.startsWith(`${method} `) && url.includes(key.slice(method.length + 1))) ??
      entries.find(([key]) => !/^[A-Z]+ /.test(key) && url.includes(key));
    if (match === undefined) return undefined; // Ivanti's empty body for "no rows"
    if (match[1] instanceof Error) throw match[1];

    if (method === 'DELETE') {
      for (const [key] of entries) {
        if (url.includes(key.replace(/^[A-Z]+ /, ''))) responses.delete(key);
      }
    }

    return match[1];
  };

  const transport: IvantiTransport = {
    routes,
    request: (url: string, init?: { method?: string }) =>
      Promise.resolve(answer(url, init?.method ?? 'GET')) as Promise<never>,
    requestRequired: (url: string, init?: { method?: string }) => {
      const payload = answer(url, init?.method ?? 'GET');
      if (payload === undefined) {
        return Promise.reject(
          new IvantiApiError({ status: 200, method: 'GET', url }, 'empty body'),
        );
      }
      return Promise.resolve(payload) as Promise<never>;
    },
    requestText: (url: string) => {
      const payload = answer(url);
      return Promise.resolve(typeof payload === 'string' ? payload : '');
    },
  };

  const metadata: MetadataCatalog = {
    entity: (ref: string) => {
      const key = ref.replace(/#$/, '').replace(/s$/, '').toLowerCase();
      const found = entities.get(key) ?? entities.get(ref.toLowerCase());
      return found === undefined
        ? Promise.reject(new UnknownEntityError(ref, [...entities.keys()]))
        : Promise.resolve(found);
    },
    entityNames: () => Promise.resolve([...entities.keys()].sort((a, b) => a.localeCompare(b))),
    graph: () => Promise.resolve(undefined),
    widen: vi.fn(() => Promise.resolve()),
  };

  const identity: SessionIdentity = { role: 'Admin', displayName: 'Service Account' };
  const session: IvantiSession = {
    call: (servicePath: string, method: string) => {
      const key = `${servicePath}/${method}`;
      urls.push(key);
      const match = Object.entries(options.sessionCalls ?? {}).find(([fragment]) =>
        key.includes(fragment),
      );
      if (match === undefined) return Promise.resolve(undefined) as Promise<never>;
      if (match[1] instanceof Error) return Promise.reject(match[1]);
      return Promise.resolve(match[1]) as Promise<never>;
    },
    callHandler: () => Promise.reject(new Error('no handler in this fixture')),
    identity: () => Promise.resolve(identity),
    identityIfKnown: () => identity,
  };

  const workspaces = createWorkspaceCatalog(session, fixtureLogger);

  // The real implementations over the fixture's transport, so a test that scopes a read
  // exercises the same resolution a tenant would. With no `employee` entity registered there are
  // no person objects, which is how a test opts out.
  const directory = createPersonDirectory({ transport, metadata, logger: fixtureLogger });

  return {
    urls,
    connection: {
      basePath: '/HEAT',
      metadataUrl: 'https://tenant.example/HEAT/api/odata/incidents/$metadata',
      transport,
      metadata,
      session,
      workspaces,
      admin: createAdminCatalog(session, fixtureLogger),
      forms: createFormContext(session, workspaces, fixtureLogger),
      people: {
        directory,
        customerLinks: createCustomerLinks({
          transport,
          personObjects: directory.personObjects,
          logger: fixtureLogger,
        }),
      },
      capability: options.capability ?? { tier: 'odata', reason: 'fixture default' },
    },
  };
}
