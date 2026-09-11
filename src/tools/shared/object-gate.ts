import type { Config } from '../../config/env-schema.js';
import { toCsdlEntity } from '../../ivanti/metadata/entity-names.js';

/**
 * Which Business Objects a tool may touch at all.
 *
 * In `full` mode the answer is "any of them" — the audience is IT staff, and narrowing would only
 * get in the way. In `enduser` mode it is the allowlist and nothing else: that mode is pointed at
 * people who should see their own service desk records, not the tenant's 1324 objects, and the
 * limit has to hold at the object a tool is *asked for* rather than inside a handler.
 *
 * Refusals name what is allowed. A model told only "no" retries with a synonym; told the three
 * objects that exist for it, it asks the right question next.
 */
export interface ObjectGate {
  /** The objects a caller may name, lowercase CSDL form. Empty means "no restriction". */
  readonly allowed: readonly string[];
  /** Whether this Business Object, in any dialect, may be used. */
  allows: (ref: string) => boolean;
}

export class ObjectNotAllowedError extends Error {
  readonly ref: string;

  constructor(ref: string, allowed: readonly string[]) {
    super(
      `This server is configured for end users and only exposes ${allowed.join(', ')}. ` +
        `'${ref}' is not one of them — say so plainly rather than looking for another way in.`,
    );
    this.name = 'ObjectNotAllowedError';
    this.ref = ref;
  }
}

/** What `full` mode gets, and what every test that is not about gating should use. */
export const OPEN_GATE: ObjectGate = { allowed: [], allows: () => true };

export function createObjectGate(config: Config): ObjectGate {
  if (config.MCP_MODE !== 'enduser') return OPEN_GATE;

  // The allowlist is already normalised to the lowercase CSDL form when config loads.
  const allowed = config.ENDUSER_BUSINESS_OBJECTS;
  const permitted = new Set(allowed);

  return {
    allowed,
    allows: (ref: string): boolean => permitted.has(toCsdlEntity(ref).toLowerCase()),
  };
}
