/**
 * URL builders for Ivanti's OData routes. Pure — the transport supplies the origin and base
 * path, these only know the shapes.
 */
export interface OdataRoutes {
  /** `…/api/odata/businessobject/Incidents` */
  entitySet: (entitySet: string) => string;
  /** `…/api/odata/businessobject/Incidents('<RecId>')` */
  record: (entitySet: string, recId: string) => string;
  /** `…/api/odata/businessobject/Incidents('<RecId>')/<Relationship>` */
  related: (entitySet: string, recId: string, relationship: string) => string;
  /** `…/Incidents('<RecId>')/<Relationship>('<TargetId>')/$Ref` — link and unlink */
  ref: (entitySet: string, recId: string, relationship: string, targetId: string) => string;
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

export function createOdataRoutes(baseUrl: string, basePath: string): OdataRoutes {
  const root = `${baseUrl.replace(/\/+$/, '')}${basePath}`;
  const bo = `${root}/api/odata/businessobject`;

  return {
    entitySet: (entitySet) => `${bo}/${entitySet}`,
    record: (entitySet, recId) => `${bo}/${entitySet}${key(recId)}`,
    related: (entitySet, recId, relationship) => `${bo}/${entitySet}${key(recId)}/${relationship}`,
    ref: (entitySet, recId, relationship, targetId) =>
      `${bo}/${entitySet}${key(recId)}/${relationship}${key(targetId)}/$Ref`,
    metadata: (graph) => `${root}/api/odata/${graph === undefined ? '' : `${graph}/`}$metadata`,
  };
}
