import type { EntityMetadata } from '../../ivanti/metadata/csdl.js';
import { toEntitySet } from '../../ivanti/metadata/entity-names.js';
import type { IvantiToolDeps } from './deps.js';

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
  const entity = await deps.connection.metadata.entity(ref);
  return { entity, entitySet: toEntitySet(`${entity.name}#`) };
}
