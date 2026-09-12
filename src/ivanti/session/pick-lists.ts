import type { IvantiSession } from './asmx-session.js';
import type { ResolvedForm } from './form-context.js';

/**
 * What a validated field may actually contain.
 *
 * Ivanti does not expose this over OData — `$metadata` says a field *is* validated and stops
 * there. The values come from the create form, and the request has to carry a DataModel so the
 * server can filter cascades: `Category` depends on `Service`, and asking without one answers
 * from the empty-parent list, which shares no values with the real one.
 */
export interface PickListOption {
  value: string;
  label: string;
  recId?: string;
}

export interface FieldPickList {
  validated: boolean;
  values: PickListOption[];
  /** Ivanti truncated the list. */
  more?: boolean;
  /** This field reuses another's options — `Category` mirrors `ActualCategory`. */
  sameAs?: string;
  /** Parent values that were applied to filter this list. */
  filteredBy?: Record<string, string>;
}

interface ValidationList {
  FieldMap?: Record<string, number>;
  Data?: unknown[][];
  More?: boolean;
  SameAs?: string;
}

interface DataModel {
  Objects?: Record<string, { Values?: Record<string, unknown> }>;
}

function cell(row: unknown[], index: number | undefined): string {
  if (index === undefined) return '';
  const value = row[index];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Decodes one list.
 *
 * The rows are columns, not objects: the stored value sits at the **lowest** index in `FieldMap`,
 * `DisplayName` labels it when present, and `RecId` identifies it. This mirrors what Ivanti's own
 * web client does with the same payload.
 */
function decode(raw: ValidationList): PickListOption[] {
  const fieldMap = raw.FieldMap ?? {};
  const indices = Object.values(fieldMap);
  if (indices.length === 0) return [];

  const valueColumn = Math.min(...indices);
  const labelColumn = fieldMap['DisplayName'] ?? valueColumn;
  const recIdColumn = fieldMap['RecId'];

  return (raw.Data ?? [])
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => {
      const value = cell(row, valueColumn);
      const recId = cell(row, recIdColumn);
      return {
        value,
        label: cell(row, labelColumn) || value,
        ...(recId === '' ? {} : { recId }),
      };
    })
    .filter((option) => option.value !== '');
}

export interface PickListRequest {
  session: IvantiSession;
  form: ResolvedForm;
  /** The AdminUI id of the object, e.g. `Incident#`. */
  objectId: string;
  fields: readonly string[];
  /** Values for the fields a list cascades on, e.g. `{ Service: 'Email' }`. */
  values?: Record<string, string>;
}

export interface PickListResult {
  lists: Record<string, FieldPickList>;
  /**
   * Values the caller supplied that the form does not have a field for. They filtered nothing,
   * and saying so is the difference between "these are the options" and "these are the options
   * for a parent you did not actually set".
   */
  ignoredValues: string[];
}

export async function readPickLists(request: PickListRequest): Promise<PickListResult> {
  const { session, form, objectId, fields, values = {} } = request;

  const lists: Record<string, FieldPickList> = {};
  const validators: Record<string, unknown> = {};

  for (const field of fields) {
    if (field in form.validatedFields) validators[field] = form.validatedFields[field];
    else lists[field] = { validated: false, values: [] };
  }

  if (Object.keys(validators).length === 0) return { lists, ignoredValues: [] };

  // A fresh DataModel per query: `GetFormDefaultData` mints a transient record — nothing is
  // persisted — in the shape the validation call requires.
  const defaults = await session.call<{ Data?: DataModel }>(
    'Services/FormService.asmx',
    'GetFormDefaultData',
    {
      formName: form.formName,
      layoutName: form.layoutName,
      masterData: null,
      objectId,
      objectType: objectId,
      overridings: null,
      viewName: form.viewName,
      dependentInfo: null,
    },
  );

  const model = defaults.Data;
  const recordId = Object.keys(model?.Objects ?? {})[0];
  const record = recordId === undefined ? undefined : model?.Objects?.[recordId];
  if (model === undefined || record === undefined) {
    throw new Error(`Ivanti returned no form data model for ${objectId}; picklists need one.`);
  }

  const known = record.Values ?? {};
  const ignoredValues = Object.keys(values).filter((field) => !(field in known));
  record.Values = { ...known, ...values };

  const answered = await session.call<Record<string, ValidationList>>(
    'Services/FormService.asmx',
    'GetFormValidationListData',
    {
      formValidationList: {
        objectId,
        NamedValidators: JSON.stringify(validators),
        ValidatorsOverride: '{}',
        MasterFormValues: model,
      },
    },
  );

  const applied = Object.fromEntries(
    Object.entries(values).filter(([field]) => !ignoredValues.includes(field)),
  );

  for (const field of Object.keys(validators)) {
    let raw = answered[field];
    let sameAs: string | undefined;

    // An empty list with `SameAs` means "reuse that field's options". Ivanti sends JSON `null`
    // rather than omitting the key when there is no such field, and `!== undefined` let that
    // through — so every filtered-but-empty list reported `"sameAs": null`, which reads as a
    // field that exists.
    if (raw !== undefined && (raw.Data ?? []).length === 0 && typeof raw.SameAs === 'string' && raw.SameAs !== '') {
      sameAs = raw.SameAs;
      raw = answered[raw.SameAs] ?? raw;
    }

    lists[field] = {
      validated: true,
      values: raw === undefined ? [] : decode(raw),
      ...(raw?.More === true ? { more: true } : {}),
      ...(sameAs === undefined ? {} : { sameAs }),
      ...(Object.keys(applied).length > 0 ? { filteredBy: applied } : {}),
    };
  }

  return { lists, ignoredValues };
}
