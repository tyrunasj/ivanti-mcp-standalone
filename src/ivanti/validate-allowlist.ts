// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { UnknownEntityError } from './metadata/catalog.js';
import type { IvantiConnection } from './connect.js';

/**
 * Checks the end-user allowlist against the tenant, once, at startup.
 *
 * The allowlist is the whole of what an end user may create on, and its entries are Business
 * Object names — which are tenant-specific, renamed by administrators, and easy to misspell in a
 * way nothing notices. A name that does not resolve would silently narrow the allowlist to
 * nothing rather than raising anything, so it is resolved here and the process refuses to start.
 *
 * Returns the problems rather than throwing, so the caller can report every bad name at once.
 */
export async function validateBusinessObjectAllowlist(
  connection: IvantiConnection,
  names: readonly string[],
): Promise<string[]> {
  const problems = await Promise.all(
    names.map(async (name) => {
      try {
        await connection.metadata.entity(name);
        return undefined;
      } catch (error: unknown) {
        if (error instanceof UnknownEntityError) {
          return `ENDUSER_BUSINESS_OBJECTS names '${name}', which this tenant does not have. ${
            error.suggestions.length > 0
              ? `Did you mean: ${error.suggestions.join(', ')}?`
              : 'Use list_business_objects against the tenant to find the right name.'
          }`;
        }
        // Anything else — a network blip, a refused read — is not evidence the name is wrong.
        return undefined;
      }
    }),
  );

  return problems.filter((problem): problem is string => problem !== undefined);
}
