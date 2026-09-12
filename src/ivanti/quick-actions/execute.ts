import type { IvantiSession } from '../session/asmx-session.js';

/**
 * Quick actions — Ivanti's own buttons: send this email, escalate, clone, close with a template.
 * They are the tenant's encoded procedures, so running one is usually more correct than writing
 * the field updates by hand.
 *
 * One endpoint drives preview, run and delete-preview, and it has two paths that are **not**
 * interchangeable:
 *
 * - **FormParams honours `shouldSave: false`** — nothing is written, and the reply says what the
 *   action would ask for.
 * - **GridParams ignores it and RUNS the action.** A "preview" over the grid path is a live
 *   execution that reports itself as a probe. This module therefore never builds GridParams.
 */
export interface QuickAction {
  actionId: string;
  name: string;
  actionType: string;
}

/** A field the action wants answered before it will run. */
export interface ActionPrompt {
  FieldName: string;
  FieldType?: string;
  Label?: string | null;
  Hidden?: boolean;
  Required?: boolean;
  Value?: unknown;
  [key: string]: unknown;
}

export interface ActionResult {
  status?: string;
  saved?: boolean;
  IsPromptRequired?: boolean;
  promptParams?: ActionPrompt[];
  /**
   * A token minted by *this* probe. A run must echo the one from its own fresh preview — an old
   * instance id is not a shortcut past previewing again.
   */
  parentActionExecutionInstanceId?: string;
  newObjectIds?: unknown;
  errors?: {
    errorMessages?: string[] | null;
    warningMessages?: string[] | null;
    validationErrors?: Record<string, unknown> | null;
  } | null;
}

/** `incident` → `Incident#`; anything already carrying a `#` passes through. */
export function toActionObjectId(ref: string): string {
  return ref.includes('#') ? ref : `${ref}#`;
}

export async function listQuickActions(
  session: IvantiSession,
  objectId: string,
): Promise<QuickAction[]> {
  const rows = await session.call<unknown[][]>(
    'QuickActions/services/QuickActionsService.asmx',
    'GetObjectQuickActions',
    { tableRef: objectId, hideComplexActions: false },
  );

  if (!Array.isArray(rows)) return [];

  const cell = (value: unknown): string => (typeof value === 'string' ? value : '');

  return rows
    .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 3)
    .map((row) => ({ actionId: cell(row[0]), name: cell(row[1]), actionType: cell(row[2]) }))
    .filter((action) => action.actionId !== '' && action.name !== '');
}

export interface ExecuteOptions {
  session: IvantiSession;
  objectId: string;
  recordId: string;
  actionId: string;
  /** The role's form. Required: the grid path would run what it claims to preview. */
  formName: string;
  shouldSave: boolean;
  prompts?: ActionPrompt[] | null;
  parentActionExecutionInstanceId?: string | null;
}

export function executeAction(options: ExecuteOptions): Promise<ActionResult> {
  const { objectId, recordId, actionId, formName } = options;

  return options.session.call<ActionResult>('Services/Save.asmx', 'SaveDataExecuteAction', {
    shouldSave: options.shouldSave,
    data: null,
    actionParams: {
      GridParams: null,
      FormParams: {
        actionId,
        objectId: recordId,
        clientData: {
          Objects: { [recordId]: { TableRef: objectId, RecordId: recordId, Values: {} } },
          ObjectRelationships: { [recordId]: {} },
        },
        isnew: false,
        formName,
        originalRecId: null,
      },
    },
    promptParams: options.prompts ?? null,
    parentActionExecutionInstanceId: options.parentActionExecutionInstanceId ?? null,
  });
}

/**
 * Ivanti's per-record, per-field validation errors, flattened into lines.
 *
 * The shape is `validationErrors[recId].fieldErrors[field].fieldMessages[]`, and those messages
 * name exactly which field blocked the action — which the top-level `status` does not.
 */
export function describeFailure(result: ActionResult): string[] {
  const lines = [...(result.errors?.errorMessages ?? [])].map(String);

  const byRecord = result.errors?.validationErrors ?? {};
  for (const record of Object.values(byRecord)) {
    if (typeof record !== 'object' || record === null) continue;
    const fieldErrors = (record as Record<string, unknown>)['fieldErrors'];
    if (typeof fieldErrors !== 'object' || fieldErrors === null) continue;

    for (const [field, detail] of Object.entries(fieldErrors)) {
      if (typeof detail !== 'object' || detail === null) continue;
      const messages = (detail as Record<string, unknown>)['fieldMessages'];
      if (!Array.isArray(messages)) continue;
      for (const message of messages) lines.push(`${field}: ${String(message)}`);
    }
  }

  return lines;
}
