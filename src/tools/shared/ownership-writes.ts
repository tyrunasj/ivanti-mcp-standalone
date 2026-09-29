// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { OdataRecord } from '../../ivanti/odata/response.js';
import { comparable } from '../../ivanti/write/compare-stored.js';
import type { IvantiToolDeps } from './deps.js';
import { FieldNameError } from './explain-field-error.js';
import { authorFields } from './own-records.js';
import type { ResolvedObject } from './resolve-object.js';

/**
 * In `enduser`, the fields that say whose record this is belong to the server, never to a write.
 *
 * Reading was scoped to the caller's own records and a create was stamped with them — and then
 * `update_record` wrote whatever it was handed, so an end user could set their own ticket's
 * customer link to a colleague and hand it over, or rewrite `CreatedBy` to say somebody else
 * filed it. The create path had the same hole in a quieter shape: the stamp was merged over the
 * caller's fields by exact key, so `profilelink_recid` rode alongside `ProfileLink_RecID` and which
 * of the two Ivanti kept was its choice, not this server's.
 *
 * Guarded: the object's customer link as discovered for scoping — its RecId and Category halves
 * and the bare link name — and the authorship fields `ownershipFields` stamps. Compared ignoring
 * case, because that is how the names reach Ivanti.
 */
export class OwnershipFieldError extends FieldNameError {
  constructor(message: string, fields: string[]) {
    super(message, fields);
    this.name = 'OwnershipFieldError';
  }
}

/**
 * @param stamp what the server itself writes on a create. A caller key carrying the SAME value is
 *   harmless — the stamp writes it anyway, and refusing someone for naming themselves would be a
 *   failed turn for nothing. On an update there is no stamp, so any guarded key is refused: the
 *   record is already theirs, and there is nothing in those fields for them to change.
 */
export async function assertOwnershipUntouched(
  deps: IvantiToolDeps,
  resolved: ResolvedObject,
  fields: OdataRecord,
  stamp: Record<string, string> = {},
): Promise<void> {
  if (!deps.ownRecordsOnly) return;

  const link = await deps.connection.people.customerLinks.forEntity(
    resolved.entity,
    resolved.entitySet,
  );

  const guarded = new Set(
    [
      ...(link === undefined
        ? []
        : [link.recIdField, link.categoryField, link.recIdField.replace(/_RecID$/i, '')]),
      ...Object.keys(authorFields('-')),
      ...Object.keys(stamp),
    ].map((name) => name.toLowerCase()),
  );
  const stamped = new Map(Object.entries(stamp).map(([name, value]) => [name.toLowerCase(), value]));

  const touched = Object.entries(fields)
    .filter(([name, value]) => {
      const key = name.toLowerCase();
      if (!guarded.has(key)) return false;
      const own = stamped.get(key);
      return own === undefined || comparable(value).trim().toLowerCase() !== own.toLowerCase();
    })
    .map(([name]) => name);

  if (touched.length === 0) return;

  const list = touched.map((name) => `\`${name}\``).join(', ');
  throw new OwnershipFieldError(
    `${list} ${touched.length === 1 ? 'says' : 'say'} whose record this is, and here that is ` +
      'always the person it is for — set by this server, never by a write, so a ticket cannot be ' +
      'handed to someone else or filed in their name. Nothing was written. Leave ' +
      `${touched.length === 1 ? 'it' : 'them'} out` +
      (Object.keys(stamp).length > 0
        ? ': the record is filed for the person you are acting for automatically.'
        : '; to involve someone else, say so in a note on the record.'),
    touched,
  );
}
