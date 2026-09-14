// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import type { IvantiTransport } from '../http/transport.js';
import { buildQuery, withQuery } from '../odata/query.js';
import { readCollection, type OdataRecord } from '../odata/response.js';

/**
 * The tenant's UTC offset, which a service-request datetime cannot be submitted without.
 *
 * Ivanti converts a submitted datetime from local wall time using `localOffset`, and the value it
 * wants is the tenant's offset **negated**. Measured on a UTC+2 tenant, sending
 * `2026-09-30T00:00:00Z`: `-120` stored it unchanged, `0` stored the previous day, and `+120`
 * stored `0001-01-01T00:00:00` — the answer destroyed while the submit still reported success.
 *
 * There is no endpoint that states the offset, so it is read off a timestamp Ivanti rendered.
 * **It has to be a recent one**: the offset in a rendered datetime is the offset *at that
 * instant*, so a 2021 row on a European tenant answers `+01:00` in the middle of a `+02:00`
 * summer. Hence the newest row rather than the first.
 *
 * This is best effort by construction, which is why every submit reads its answers back: a wrong
 * offset shows up as a stored value that differs from the one sent, and is reported as such
 * rather than passing silently.
 */

/** Objects worth asking, most-likely-to-be-active first. */
const SOURCES = ['servicereqs', 'incidents', 'employees'];

const OFFSET = /[+-]\d{2}:\d{2}$/;

export interface TenantOffset {
  /** Minutes east of UTC — `+120` for a tenant on UTC+2. */
  minutes: number;
  /** The timestamp it was read from. An old one may be a daylight-saving change behind. */
  observedAt: string;
}

export interface TenantOffsetReader {
  /** Undefined when no timestamp could be found — the caller must then say so, not assume zero. */
  get: () => Promise<TenantOffset | undefined>;
}

function parseOffset(row: OdataRecord): TenantOffset | undefined {
  for (const value of Object.values(row)) {
    if (typeof value !== 'string') continue;
    const match = OFFSET.exec(value);
    if (match === null) continue;

    const sign = match[0].startsWith('-') ? -1 : 1;
    const hours = Number(match[0].slice(1, 3));
    const minutes = Number(match[0].slice(4, 6));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) continue;

    return { minutes: sign * (hours * 60 + minutes), observedAt: value };
  }
  return undefined;
}

export function createTenantOffsetReader(
  transport: IvantiTransport,
  logger: Logger,
): TenantOffsetReader {
  let found: Promise<TenantOffset | undefined> | undefined;

  const discover = async (): Promise<TenantOffset | undefined> => {
    for (const entitySet of SOURCES) {
      const url = withQuery(
        transport.routes.entitySet(entitySet),
        // The newest row, because the offset is the one in force when the row was written.
        buildQuery({ top: 1, orderBy: 'LastModDateTime desc' }),
      );
      try {
        const rows = readCollection<OdataRecord>(await transport.request<OdataRecord>(url), url);
        const offset = rows.length > 0 && rows[0] !== undefined ? parseOffset(rows[0]) : undefined;
        if (offset !== undefined) {
          logger.debug('tenant utc offset', { minutes: offset.minutes, from: entitySet });
          return offset;
        }
      } catch (error: unknown) {
        logger.debug('tenant offset source unreadable', {
          entitySet,
          error: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }
    return undefined;
  };

  return {
    get(): Promise<TenantOffset | undefined> {
      found ??= discover();
      return found;
    },
  };
}
