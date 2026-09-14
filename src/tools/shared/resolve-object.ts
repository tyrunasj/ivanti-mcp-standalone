// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { EntityMetadata } from '../../ivanti/metadata/csdl.js';
import { toEntitySet } from '../../ivanti/metadata/entity-names.js';
import type { IvantiToolDeps } from './deps.js';
import { ObjectNotAllowedError } from './object-gate.js';

export interface ResolvedObject {
  entity: EntityMetadata;
  /** The entity-set segment the CRUD routes take. */
  entitySet: string;
}

/**
 * Turns whatever the caller called the Business Object into the entity set its records live in.
 *
 * Going through the metadata catalog rather than converting the string directly is deliberate:
 * it costs nothing after the first call, and it turns a wrong name into a naming error *with
 * suggestions* before any query is sent. Ivanti's own answer to a wrong entity set is an empty
 * result, which reads as "there are no such records".
 */
export async function resolveObject(deps: IvantiToolDeps, ref: string): Promise<ResolvedObject> {
  // Checked before the name is even resolved: in enduser mode an object outside the allowlist
  // must not be confirmed to exist, let alone read.
  if (!deps.gate.allows(ref)) throw new ObjectNotAllowedError(ref, deps.gate.allowed);

  const entity = await deps.connection.metadata.entity(ref);

  // The caller may have named an alias the catalog resolved to something else, so the resolved
  // name is checked too.
  if (!deps.gate.allows(entity.name)) throw new ObjectNotAllowedError(ref, deps.gate.allowed);

  return { entity, entitySet: toEntitySet(`${entity.name}#`) };
}
