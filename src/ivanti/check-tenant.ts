// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.
import type { IvantiConnection } from './connect.js';
import { looksLikeCsdl } from './metadata/csdl.js';

/**
 * Does the tenant still answer this key the way it did at startup?
 *
 * The same request startup proved with — the `$metadata` document it settled on — because it is
 * authenticated, answers under any tenant's schema, and has a body that can be checked: a 200
 * carrying a login or maintenance page is still a tenant that cannot serve a tool call. No
 * Business Object is named, so nothing here depends on what the tenant ships.
 *
 * Through the connection's own transport, so through `exchange()`: timed out, scrubbed, logged.
 */
export async function checkTenant(
  connection: Pick<IvantiConnection, 'transport' | 'metadataUrl'>,
): Promise<void> {
  const body = await connection.transport.requestText(connection.metadataUrl);
  if (!looksLikeCsdl(body)) {
    throw new Error('the tenant answered, but not with its schema — a login or maintenance page?');
  }
}
