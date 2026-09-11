import type { Logger } from '../../logger.js';
import { servesEntity, toCsdlEntity } from '../metadata/entity-names.js';
import type { IvantiSession } from './asmx-session.js';
import type { WorkspaceCatalog } from './workspaces.js';

/**
 * The create form Ivanti would show a person for one Business Object.
 *
 * It is the only session-reachable source for what a *validated* field may contain, and getting
 * to it is a walk: the role's workspaces name a layout, the layout names a create view, and the
 * view names a form. A bare `GetFormValidationListData` without that context fails with a
 * misleading "You do not have permission to view this item".
 */
export interface ResolvedForm {
  layoutName: string;
  viewName: string;
  formName: string;
  /** The fields whose values come from a list, keyed by field name. */
  validatedFields: Record<string, unknown>;
}

export interface FormContext {
  /** The form for this Business Object, or undefined when the role has no workspace for it. */
  get: (entityRef: string) => Promise<ResolvedForm | undefined>;
}

interface WorkspaceData {
  ObjectId?: string;
  LayoutData?: {
    newRecordViews?: Record<string, string> | null;
    oneNewRecordView?: string | null;
  } | null;
}

interface FormViewData {
  formDef?: {
    FormMeta?: { Name?: string };
    TableMeta?: { TableRef?: string; ValidatedFields?: Record<string, unknown> };
  };
}

export function createFormContext(
  session: IvantiSession,
  workspaces: WorkspaceCatalog,
  logger: Logger,
): FormContext {
  const cache = new Map<string, Promise<ResolvedForm | undefined>>();

  const resolve = async (entityRef: string): Promise<ResolvedForm | undefined> => {
    const objectId = `${toCsdlEntity(entityRef).replace(/__/g, '#')}#`.replace(/##$/, '#');
    const candidates = await workspaces.list();

    // The workspace whose object this is, first; the rest are not worth walking.
    const workspace = candidates.find((entry) => servesEntity(objectId, entry.id));
    if (workspace === undefined) {
      logger.debug('no workspace serves this object, so it has no form', { objectId });
      return undefined;
    }

    const data = await session.call<WorkspaceData>('Services/Workspace.asmx', 'GetWorkspaceData', {
      ObjectId: workspace.id,
      LayoutName: workspace.layoutName,
    });

    const views = data.LayoutData?.newRecordViews ?? {};
    const viewName =
      views[workspace.id] ?? data.LayoutData?.oneNewRecordView ?? Object.values(views)[0];
    if (viewName === undefined || viewName === '') return undefined;

    const view = await session.call<FormViewData>('Services/Workspace.asmx', 'FindFormViewData', {
      createdViewsOnClient: {},
      isNewRecord: true,
      layoutName: workspace.layoutName,
      objectId: workspace.id,
      viewName,
    });

    const formName = view.formDef?.FormMeta?.Name;
    const table = view.formDef?.TableMeta;
    const validatedFields = table?.ValidatedFields;
    if (formName === undefined || validatedFields === undefined) return undefined;

    // Ivanti resolves a form from the LAYOUT, so asking the wrong layout still answers 200 — with
    // another object's form, and another object's picklists. `TableRef` is the form's own
    // statement of what it describes, and it is the only trustworthy identity here.
    if (!servesEntity(workspace.id, table?.TableRef)) {
      logger.warn('the form Ivanti returned describes another object; ignoring it', {
        asked: workspace.id,
        served: table?.TableRef,
      });
      return undefined;
    }

    return { layoutName: workspace.layoutName, viewName, formName, validatedFields };
  };

  return {
    get: (entityRef: string): Promise<ResolvedForm | undefined> => {
      const key = toCsdlEntity(entityRef).toLowerCase();
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      // The walk is three calls; the answer cannot change while the server runs.
      const pending = resolve(entityRef);
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
      return pending;
    },
  };
}
