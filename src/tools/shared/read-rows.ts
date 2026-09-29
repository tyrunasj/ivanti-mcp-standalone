// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { readCollection } from '../../ivanti/odata/response.js';
import { countRowsRead } from '../../usage/call-usage.js';

/**
 * `readCollection`, with the rows counted for the call's usage line.
 *
 * Here rather than inside `readCollection`, which is pure and stays so: every tool reads its
 * collections through this, so the count cannot be forgotten by one of them, and `src/ivanti`
 * learns nothing about calls.
 */
export function readRows<T>(payload: unknown, url: string): T[] {
  const rows = readCollection<T>(payload, url);
  countRowsRead(rows.length);
  return rows;
}
