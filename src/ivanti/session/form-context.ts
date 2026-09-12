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
  /**
   * Display name (lowercased) → field name. Ivanti's refusals name the **display** name —
   * "Required field Incident.Description value must be provided" means `Symptom` — so a caller
   * cannot act on the message without this.
   */
  displayNames: Record<string, string>;
  /**
   * Field name → what a person is shown for it.
   *
   * Ivanti has **three** naming layers, and they are resolved in this order:
   *
   * 1. the **form's** label for the control bound to that field — a form may rename a field for
   *    its own users, and that is what those users actually read;
   * 2. the object's **display name** (`TableMeta.Fields[].DisplayName`) — `Symptom` → `Description`;
   * 3. the technical **name**, when nothing else exists.
   *
   * Layer 1 is only as complete as the form this context resolved. That form is the create/header
   * form, which on a stock tenant binds very few fields, so most labels come from layer 2 — and a
   * field renamed on some *other* form will not be seen here. Knowing which layer answered
   * matters more than pretending there is one name.
   */
  fieldLabels: Record<string, string>;
  /**
   * Link field → the identifier field that sets it: `ProfileLink` → `ProfileLink_RecID`. A link
   * is written as a pair, the RecId and a `_Category` naming the target object, so being told
   * "Customer is required" is only useful alongside this.
   */
  linkFields: Record<string, string>;
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
    FormMeta?: {
      Name?: string;
      /** Keyed by control name; a control bound to a field carries `FieldRef`. */
      Controls?: Record<string, { FieldRef?: string; Label?: string }>;
    };
    TableMeta?: {
      TableRef?: string;
      ValidatedFields?: Record<string, unknown>;
      Fields?: Record<string, { DisplayName?: string }>;
    };
    /** `ProfileLink_RecID` → `ProfileLink`, the other way round from how it is written. */
    LinkIdMap?: Record<string, string>;
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

    const displayNames: Record<string, string> = {};
    const fieldLabels: Record<string, string> = {};

    // Layer 2 first, so layer 1 can override it below.
    for (const [name, meta] of Object.entries(table?.Fields ?? {})) {
      const display = meta.DisplayName;
      if (typeof display === 'string' && display !== '') {
        displayNames[display.toLowerCase()] ??= name;
        fieldLabels[name] = display;
      }
    }

    // Layer 1: what this form calls the field, which is what its users read. Control labels
    // routinely end in a colon, which is punctuation rather than part of the name.
    for (const control of Object.values(view.formDef?.FormMeta?.Controls ?? {})) {
      const field = control.FieldRef;
      const label = control.Label?.replace(/\s*:\s*$/, '').trim();
      if (typeof field === 'string' && field !== '' && label !== undefined && label !== '') {
        fieldLabels[field] = label;
        displayNames[label.toLowerCase()] ??= field;
      }
    }

    const linkFields: Record<string, string> = {};
    for (const [idField, linkField] of Object.entries(view.formDef?.LinkIdMap ?? {})) {
      if (typeof linkField === 'string') linkFields[linkField] = idField;
    }

    return {
      layoutName: workspace.layoutName,
      viewName,
      formName,
      validatedFields,
      displayNames,
      fieldLabels,
      linkFields,
    };
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

/**
 * The fields a validated field's list is filtered by.
 *
 * Ivanti keeps them on the validated field itself: `Category.Condition.FieldRefs` is
 * `["(other)[CI#Service.Rev2]Name", "Service"]`. The `(other)` entries point into another object
 * and are not fields of this record, so only the plain names are usable as parents.
 */
export function constrainedBy(form: ResolvedForm, field: string): string[] {
  const meta = form.validatedFields[field];
  if (typeof meta !== 'object' || meta === null) return [];

  const condition = (meta as Record<string, unknown>)['Condition'];
  if (typeof condition !== 'object' || condition === null) return [];

  const refs = (condition as Record<string, unknown>)['FieldRefs'];
  if (!Array.isArray(refs)) return [];

  return refs.filter((ref): ref is string => typeof ref === 'string' && !ref.startsWith('(other)'));
}

export interface LinkField {
  /** The link itself, e.g. `ProfileLink`. */
  field: string;
  /** What a person calls it — `Customer`. */
  displayName: string;
  /** The field that takes the target's RecId. */
  recIdField: string;
  /** The field that names the object the target lives in, e.g. "Employee". */
  categoryField: string;
}

/**
 * The links on this object, and the **pair of fields** each one is written through.
 *
 * A link is not a column: setting a customer means `ProfileLink_RecID` plus
 * `ProfileLink_Category`, and Ivanti's own refusal calls the thing "Customer", which is neither.
 */
export function linkFieldsOf(form: ResolvedForm): LinkField[] {
  return Object.entries(form.linkFields)
    .map(([field, recIdField]) => ({
      field,
      // The label as Ivanti writes it — `Customer`, not `profilelink`.
      displayName: form.fieldLabels[field] ?? field,
      recIdField,
      categoryField: `${recIdField.replace(/_RecID$/i, '')}_Category`,
    }))
    .sort((a, b) => a.field.localeCompare(b.field));
}
