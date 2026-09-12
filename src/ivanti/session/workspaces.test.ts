import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import type { IvantiSession } from './asmx-session.js';
import { createWorkspaceCatalog } from './workspaces.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const WORKSPACES = {
  Workspaces: [
    { ID: 'Incident#', Name: 'Incident', LayoutName: 'IncidentLayout.SD', Profile: 'ObjectWorkspace' },
    // The layout said `Car`; the object is `XLJ_Car#`. Deriving it from the layout got this wrong.
    { ID: 'XLJ_Car#', Name: 'Car', Profile: 'ObjectWorkspace' },
    { ID: 'CI#Service', Name: 'CI Service', Profile: 'ObjectWorkspace' },
    { ID: 'DashboardV2Workspace#Home', Name: 'Home', Profile: 'DashboardV2Workspace' },
    { ID: 'Report#Report', Name: 'Report', Profile: 'Report' },
    { Name: 'No id at all', Profile: 'ObjectWorkspace' },
  ],
};

const session = (): { session: IvantiSession; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    session: {
      identity: () => Promise.resolve({ role: 'Admin' }),
      identityIfKnown: () => ({ role: 'Admin' }),
      callHandler: () => Promise.reject(new Error('unused')),
      uploadToHandler: () => Promise.reject(new Error('no handler in this fixture')),
      call: (servicePath: string, method: string) => {
        calls.push(method);
        if (method === 'GetRoleWorkspaces') return Promise.resolve(WORKSPACES) as Promise<never>;
        return Promise.reject(new Error(`unexpected call: ${method}`));
      },
    },
  };
};

describe('listWorkspaceObjects', () => {
  it('takes the object id straight from the workspace, in one call', async () => {
    const { session: live, calls } = session();

    const objects = await createWorkspaceCatalog(live, logger()).list();

    expect(objects).toEqual([
      { id: 'CI#Service', object: 'ci__service', displayName: 'CI Service', layoutName: '' },
      {
        id: 'Incident#',
        object: 'incident',
        displayName: 'Incident',
        // The layout is carried through: it is the entry point to the object's form.
        layoutName: 'IncidentLayout.SD',
      },
      { id: 'XLJ_Car#', object: 'xlj_car', displayName: 'Car', layoutName: '' },
    ]);
    // No per-workspace confirmation: `GetRoleWorkspaces` already carries the id.
    expect(calls).toEqual(['GetRoleWorkspaces']);
  });

  it('ignores dashboards, reports and rows with no id', async () => {
    const { session: live } = session();

    const objects = await createWorkspaceCatalog(live, logger()).list();

    expect(objects.map((entry) => entry.id)).not.toContain('DashboardV2Workspace#Home');
    expect(objects).toHaveLength(3);
  });

  it('reads the catalog once per process — workspaces do not change while the server runs', async () => {
    const { session: live, calls } = session();
    const catalog = createWorkspaceCatalog(live, logger());

    await catalog.list();
    await catalog.list();

    expect(calls.filter((call) => call === 'GetRoleWorkspaces')).toHaveLength(1);
  });

  it('does not cache a failure — it is usually a permission the tenant can grant', async () => {
    let attempts = 0;
    const live = {
      identity: () => Promise.resolve({ role: 'Admin' }),
      identityIfKnown: () => ({ role: 'Admin' }),
      call: (_service: string, method: string) => {
        if (method === 'GetRoleWorkspaces') {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error('403'))
            : (Promise.resolve({ Workspaces: [] }) as Promise<never>);
        }
        return Promise.reject(new Error('unused'));
      },
    } as unknown as IvantiSession;
    const catalog = createWorkspaceCatalog(live, logger());

    await expect(catalog.list()).rejects.toThrow('403');
    await expect(catalog.list()).resolves.toEqual([]);
  });
});
