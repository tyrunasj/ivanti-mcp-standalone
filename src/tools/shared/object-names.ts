// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { IvantiConnection } from '../../ivanti/connect.js';

/**
 * Every Business Object name the credential can see, from the widest source it has.
 *
 * The metadata graphs name what they relate to — around 194 on a live tenant — while the admin
 * console names all 1324. Subtype detection in particular needs the wide list: `task__assignment`
 * appears in no graph fetched by default, so asking only the metadata catalog reports `Tasks` as
 * having no subtypes, which is how a create against a base type ends up explained as a missing
 * field.
 */
export async function knownObjectNames(connection: IvantiConnection): Promise<string[]> {
  const names = new Set(await connection.metadata.entityNames().catch(() => []));

  if (connection.capability.tier === 'admin') {
    for (const object of await connection.admin.list().catch(() => [])) {
      names.add(object.object);
    }
  }

  return [...names];
}
