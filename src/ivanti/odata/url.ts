// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * URL builders for the surfaces one API key reaches: OData for records, REST for the handful of
 * services that never got an OData shape, and CSDL for the schema. They share an origin and a
 * base path, so they are built together; the transport supplies both and these only know shapes.
 *
 * Pure by design — every one of them is a string function, testable without a tenant.
 */
export interface IvantiRoutes {
  /** `…/api/odata/businessobject/Incidents` */
  entitySet: (entitySet: string) => string;
  /** `…/api/odata/businessobject/Incidents('<RecId>')` */
  record: (entitySet: string, recId: string) => string;
  /** `…/api/odata/businessobject/Incidents('<RecId>')/<Relationship>` */
  related: (entitySet: string, recId: string, relationship: string) => string;
  /** `…/Incidents('<RecId>')/<Relationship>('<TargetId>')/$Ref` — link and unlink */
  ref: (entitySet: string, recId: string, relationship: string, targetId: string) => string;
  /** `…/businessobject/Incidents/<Saved search name>` — a saved search runs as a route segment. */
  savedSearch: (entitySet: string, name: string) => string;
  /** `…/api/rest/<path>` — the REST surface, on the same key as OData. */
  rest: (path: string) => string;
  /**
   * `…/Services/Session.asmx/InitializeSession` — the ASMX surface, which authenticates with a
   * SID cookie and a CSRF token rather than the API-key header.
   */
  service: (path: string) => string;
  /**
   * The CSDL document for a named graph — `incidents` returns the whole related graph — or the
   * service-root form when omitted, which most tenants have disabled.
   */
  metadata: (graph?: string) => string;
}

/**
 * Ivanti keys are single-quoted strings, so a quote inside one would break out of the key.
 *
 * `encodeURIComponent` does **not** escape `'` — it is an unreserved character — so it has to be
 * escaped explicitly. RecIds are 32-char hex in practice, but the builder should not depend on
 * its callers being well behaved.
 */
function key(recId: string): string {
  return `('${encodeURIComponent(recId).replace(/'/g, '%27')}')`;
}

export function createIvantiRoutes(baseUrl: string, basePath: string): IvantiRoutes {
  const root = `${baseUrl.replace(/\/+$/, '')}${basePath}`;
  const bo = `${root}/api/odata/businessobject`;

  return {
    entitySet: (entitySet) => `${bo}/${entitySet}`,
    record: (entitySet, recId) => `${bo}/${entitySet}${key(recId)}`,
    related: (entitySet, recId, relationship) => `${bo}/${entitySet}${key(recId)}/${relationship}`,
    ref: (entitySet, recId, relationship, targetId) =>
      `${bo}/${entitySet}${key(recId)}/${relationship}${key(targetId)}/$Ref`,
    savedSearch: (entitySet, name) => `${bo}/${entitySet}/${encodeURIComponent(name)}`,
    rest: (path: string) => `${root}/api/rest/${path.replace(/^\/+/, '')}`,
    service: (path: string) => `${root}/${path.replace(/^\/+/, '')}`,
    // The graph name is caller-derived and was the ONE segment in this file interpolated raw,
    // against the principle stated above. A `#` in an object name truncates the URL at a fragment,
    // so a lookup meant for `$metadata` sent an authenticated GET to a different path entirely —
    // and `../` would have walked out of `/api/odata/`. A blind primitive rather than a readable
    // one (the body only ever reaches `parseCsdl`), but it is still a request this code never
    // meant to make.
    metadata: (graph) =>
      `${root}/api/odata/${graph === undefined ? '' : `${encodeURIComponent(graph)}/`}$metadata`,
  };
}
