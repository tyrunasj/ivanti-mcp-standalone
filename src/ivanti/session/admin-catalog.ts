import type { Logger } from '../../logger.js';
import type { IvantiSession } from './asmx-session.js';

/**
 * The tenant's **complete** Business Object catalog, from the admin console service.
 *
 * This is the widest source by a long way: 1324 objects on a live tenant, against 194 from the
 * metadata graphs and 24 from the role's workspaces — with display names, descriptions and the
 * flags that say which objects are picklists and which the product considers commonly used.
 *
 * It requires a key whose role can reach `/HEAT/AdminUI/`, which not every customer will issue.
 * So it is **used when available and never required**: every feature built on it degrades to the
 * workspace catalog, and then to the metadata names.
 *
 * Note the `services/` segment. `/HEAT/AdminUI/AppDesign.asmx/…` answers 404 — the path that
 * works is `/HEAT/AdminUI/services/AppDesign.asmx/…`.
 */
const ADMIN_SERVICE = 'AdminUI/services/AppDesign.asmx';

export interface AdminBusinessObject {
  /** The AdminUI id, e.g. `Incident#`, `CI#Computer`. */
  id: string;
  /** The CSDL-style name the metadata catalog is keyed by, lowercase. */
  object: string;
  displayName: string;
  description?: string;
  /** Ivanti's own "people use this one" flag — nine objects on a stock tenant. */
  commonlyUsed: boolean;
  /** A validation list (`IncidentStatus#`) rather than something records live in. */
  validationList: boolean;
}

interface BriefBusinessObject {
  id?: string;
  name?: string;
  displayName?: string;
  description?: string;
  commonlyUsed?: string | boolean;
  pureValidationObject?: string | boolean;
}

/** Ivanti sends these as the strings 'True' / 'False' as often as as booleans. */
function isTrue(value: string | boolean | undefined): boolean {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true');
}

export interface AdminCatalog {
  list: () => Promise<AdminBusinessObject[]>;
}

async function readAdminCatalog(
  session: IvantiSession,
  logger: Logger,
): Promise<AdminBusinessObject[]> {
  const rows = await session.call<BriefBusinessObject[]>(
    ADMIN_SERVICE,
    'GetBriefBusinessObjects',
  );

  const objects = (Array.isArray(rows) ? rows : [])
    .filter((row): row is BriefBusinessObject & { id: string } => typeof row.id === 'string')
    .map((row) => ({
      id: row.id,
      object: row.id.replace(/#$/, '').replace(/#/g, '__').toLowerCase(),
      displayName: row.displayName ?? row.name ?? row.id,
      ...(row.description === undefined || row.description === ''
        ? {}
        : { description: row.description }),
      commonlyUsed: isTrue(row.commonlyUsed),
      validationList: isTrue(row.pureValidationObject),
    }));

  logger.info('ivanti admin catalog read', { objects: objects.length });
  return objects;
}

/**
 * Reads the admin catalog once per process. It is half a megabyte of JSON and the answer does not
 * change while the server runs; a failure is not cached, because it is usually a permission.
 */
export function createAdminCatalog(session: IvantiSession, logger: Logger): AdminCatalog {
  let cached: Promise<AdminBusinessObject[]> | undefined;

  return {
    list: (): Promise<AdminBusinessObject[]> => {
      cached ??= readAdminCatalog(session, logger);
      const pending = cached;
      pending.catch(() => {
        if (cached === pending) cached = undefined;
      });
      return pending;
    },
  };
}
