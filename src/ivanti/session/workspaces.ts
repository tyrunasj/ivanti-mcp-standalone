import type { Logger } from '../../logger.js';
import type { IvantiSession } from './asmx-session.js';

/**
 * The Business Objects the session's role has a workspace for.
 *
 * Narrower than the metadata-derived catalog — OData access is governed by Object Permissions,
 * not workspace membership — but richer: proper casing, a human display name, and the knowledge
 * that someone put this object on a role's menu, which is a decent proxy for "commonly used".
 */
export interface WorkspaceObject {
  /** The AdminUI id, e.g. `Incident#`. */
  id: string;
  /** The CSDL-style name the metadata catalog is keyed by, lowercase. */
  object: string;
  displayName: string;
  /** The layout this workspace renders — the entry point to the object's form. */
  layoutName: string;
}

interface RoleWorkspace {
  /** The Business Object id, e.g. `Incident#`, `CI#Service`, `OnboardingRequest#`. */
  ID?: string;
  Name?: string;
  LayoutName?: string;
  /**
   * `ObjectWorkspace` for a workspace over records. The rest — dashboards, reports, calendars —
   * carry a profile name where the object id would be (`DashboardV2Workspace#Home`).
   */
  Profile?: string;
}

interface RoleWorkspaces {
  Workspaces?: RoleWorkspace[] | null;
}

const OBJECT_WORKSPACE = 'ObjectWorkspace';

export interface WorkspaceCatalog {
  list: () => Promise<WorkspaceObject[]>;
}

/**
 * One call, no guessing.
 *
 * `GetRoleWorkspaces` carries the Business Object id in `ID` — `Incident#`, `OnboardingRequest#`,
 * `XLJ_Car#` — so deriving it from the layout name and asking `GetWorkspaceData` to confirm the
 * guess (which answers **500** when the guess is wrong) was never necessary. Measured live: 24 of
 * 31 rows are object workspaces and every one of their ids is a real object, while the layout
 * derivation got `Onboarding#` for `OnboardingRequest#` and `Car#` for `XLJ_Car#`.
 */
async function readWorkspaceObjects(
  session: IvantiSession,
  logger: Logger,
): Promise<WorkspaceObject[]> {
  const { role } = await session.identity();

  const workspaces = await session.call<RoleWorkspaces>(
    'Services/Workspace.asmx',
    'GetRoleWorkspaces',
    { sRole: role },
  );

  const found = new Map<string, WorkspaceObject>();

  for (const workspace of workspaces.Workspaces ?? []) {
    const id = workspace.ID;
    // A dashboard or a report is not a Business Object, and its `ID` names the profile instead.
    if (workspace.Profile !== OBJECT_WORKSPACE || id === undefined || !id.includes('#')) continue;

    found.set(id.toLowerCase(), {
      id,
      object: id.replace(/#$/, '').replace(/#/g, '__').toLowerCase(),
      displayName: workspace.Name ?? id,
      layoutName: workspace.LayoutName ?? '',
    });
  }

  logger.debug('workspace objects read', { workspaces: found.size });

  return [...found.values()].sort((a, b) => a.object.localeCompare(b.object));
}

/**
 * Reads the workspace catalog **once** per process.
 *
 * Which objects a role has workspaces for does not change while the server runs, and the read
 * costs one call per workspace — not something to repeat on every `list_business_objects`.
 * A failure is not cached: it is usually a permission the tenant can grant.
 */
export function createWorkspaceCatalog(
  session: IvantiSession,
  logger: Logger,
): WorkspaceCatalog {
  let cached: Promise<WorkspaceObject[]> | undefined;

  return {
    list: (): Promise<WorkspaceObject[]> => {
      cached ??= readWorkspaceObjects(session, logger);
      const pending = cached;
      pending.catch(() => {
        if (cached === pending) cached = undefined;
      });
      return pending;
    },
  };
}
