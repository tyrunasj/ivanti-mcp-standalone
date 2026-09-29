// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { EntityField } from '../../ivanti/metadata/csdl.js';

/**
 * An object's fields as table rows — `name|type|label|flags`, one per line.
 *
 * `get_object_metadata` was the dearest result this server returns: an incident's was 20,000
 * characters, an employee's 37,000, and a result stays in the conversation for every request after
 * it. Most of that was shape, not content — the same four keys spelled out on every one of 162
 * fields, and every link listed three times. Rows keep every fact and drop the repetition.
 */
export interface FieldRow {
  name: string;
  /** The short type, or `link` for a folded link. */
  type: string;
  /** What the tenant calls it, only when that differs from the name. */
  label?: string;
  flags: string[];
  /** The fields this row stands for — one, or a link's three. What `search` matches against. */
  covers: string[];
}

export interface FieldFacts {
  labels: Readonly<Record<string, string>>;
  sometimesRequired: ReadonlySet<string>;
  readOnly: ReadonlySet<string>;
}

export const FIELDS_FORMAT =
  'One field per line: name|type|label|flags. `label` is what the tenant shows, when it differs. ' +
  'Flags: `required` (always), `required?` and `readOnly?` (a form rule governs it in some ' +
  'states), `validated` (the value comes from a picklist). Type `link` is three fields: `<name>` ' +
  "(the linked record's display value), `<name>_RecID` (its RecId — filter on this) and " +
  '`<name>_Category` (its object) — a write sets `_RecID` and `_Category` together.';

/** `Edm.String` → `String`. The prefix is on every field of every entity and carries nothing. */
function shortType(type: string): string {
  return type.replace(/^Edm\./, '');
}

function flagsOf(field: EntityField, facts: FieldFacts): string[] {
  return [
    // The schema's `false` is absolute; the form's rule is conditional, and weaker.
    !field.nullable ? 'required' : facts.sometimesRequired.has(field.name) ? 'required?' : '',
    facts.readOnly.has(field.name) ? 'readOnly?' : '',
    field.validated ? 'validated' : '',
  ].filter((flag) => flag !== '');
}

/** A label only when it says something the name does not — `Owner` labelled "Owner" is noise. */
function labelOf(name: string, facts: FieldFacts): string | undefined {
  const label = facts.labels[name];
  return label === undefined || label === name ? undefined : label;
}

/**
 * One row per field, with each link folded into one.
 *
 * A link is recognised by its shape — `X`, `X_RecID` and `X_Category` all present — never by a
 * list of the links Ivanti ships, because tenants add their own. The row keeps what the three
 * said between them: the label (incident's "Customer" sits on `ProfileLink_RecID`, not on
 * `ProfileLink`) and every flag, since a required `_RecID` is a required link.
 */
export function fieldRows(fields: readonly EntityField[], facts: FieldFacts): FieldRow[] {
  const names = new Set(fields.map((field) => field.name));
  const byName = new Map(fields.map((field) => [field.name, field]));
  const links = new Set(
    fields
      .map((field) => field.name)
      .filter((name) => names.has(`${name}_RecID`) && names.has(`${name}_Category`)),
  );
  const folded = new Set([...links].flatMap((link) => [`${link}_RecID`, `${link}_Category`]));

  return fields
    .filter((field) => !folded.has(field.name))
    .map((field): FieldRow => {
      if (!links.has(field.name)) {
        const label = labelOf(field.name, facts);
        return {
          name: field.name,
          type: shortType(field.type),
          ...(label === undefined ? {} : { label }),
          flags: flagsOf(field, facts),
          covers: [field.name],
        };
      }
      const covers = [field.name, `${field.name}_RecID`, `${field.name}_Category`];
      const parts = covers.map((name) => byName.get(name)).filter((part) => part !== undefined);
      const label = [`${field.name}_RecID`, field.name, `${field.name}_Category`]
        .map((name) => labelOf(name, facts))
        .find((found) => found !== undefined);
      const flags = new Set(parts.flatMap((part) => flagsOf(part, facts)));
      // `required` says more than `required?`; both would read as a contradiction.
      if (flags.has('required')) flags.delete('required?');
      return {
        name: field.name,
        type: 'link',
        ...(label === undefined ? {} : { label }),
        flags: ['required', 'required?', 'readOnly?', 'validated'].filter((flag) => flags.has(flag)),
        covers,
      };
    });
}

/** Whether a row answers a search — on any field it stands for, or on its label. */
export function rowMatches(row: FieldRow, search: string): boolean {
  const needle = search.toLowerCase();
  return (
    row.covers.some((name) => name.toLowerCase().includes(needle)) ||
    (row.label?.toLowerCase().includes(needle) ?? false)
  );
}

/** The header, then one line per row. Trailing empty cells are dropped; a `|` in a label is not. */
export function renderRows(rows: readonly FieldRow[]): string {
  const cell = (text: string): string => text.replaceAll('|', '/');
  return [
    'name|type|label|flags',
    ...rows.map((row) =>
      [row.name, row.type, cell(row.label ?? ''), row.flags.join(' ')].join('|').replace(/\|+$/, ''),
    ),
  ].join('\n');
}
