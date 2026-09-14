// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { XMLParser } from 'fast-xml-parser';

/**
 * Ivanti's CSDL (`$metadata`) is the only field-level schema an API key can read without admin
 * rights, so it is the backbone of every read tool: which fields exist, which are picklists, and
 * what a record may be related to.
 *
 * The document is parsed **once** into a map keyed by lowercase entity name. Ivanti serves
 * entity types lowercase (`incident`, `frs_knowledge`) while every other surface uses mixed case,
 * so lookups are case-insensitive by construction rather than by convention.
 */

export interface EntityField {
  name: string;
  type: string;
  nullable: boolean;
  /** Has a `_Valid` twin: the value comes from a validation list, not free text. */
  validated: boolean;
  /**
   * This field *is* a `_Valid` twin whose display field exists on the same entity — a 32-char
   * RecId pointer Ivanti maintains itself. Hidden by default: neither readable nor writable in
   * any useful sense, and roughly 20-30 of them per entity is pure noise.
   */
  internalTwin: boolean;
}

export interface EntityRelationship {
  name: string;
  /** The CSDL entity on the other side, lowercase as Ivanti reports it. */
  target: string;
}

export interface EntityMetadata {
  name: string;
  fields: EntityField[];
  relationships: EntityRelationship[];
}

export interface CsdlDocument {
  /** Keyed by lowercase entity name. */
  entities: ReadonlyMap<string, EntityMetadata>;
}

/** A CSDL document, as opposed to a login page or a WAF interstitial answering 200. */
export function looksLikeCsdl(body: string): boolean {
  return /<(edmx:)?Edmx[\s>]/i.test(body);
}

interface RawProperty {
  '@_Name': string;
  '@_Type'?: string;
  '@_Nullable'?: string;
  '@_MaxLength'?: string;
  '@_Unicode'?: string;
}

interface RawNavigationProperty {
  '@_Name': string;
  /** CSDL 4: `MetaData.task` or `Collection(MetaData.task)`. */
  '@_Type'?: string;
  /** CSDL 3 only. */
  '@_ToRole'?: string;
}

interface RawEntityType {
  '@_Name': string;
  Property?: RawProperty[];
  NavigationProperty?: RawNavigationProperty[];
}

interface RawDocument {
  Edmx?: { DataServices?: { Schema?: { EntityType?: RawEntityType[] }[] } };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Namespace prefixes vary (`edmx:Edmx` vs `Edmx`); strip them so one traversal handles both.
  removeNSPrefix: true,
  // Repeated elements must stay arrays even when a schema happens to hold exactly one.
  isArray: (name): boolean =>
    ['Property', 'NavigationProperty', 'EntityType', 'Schema'].includes(name),
});

const VALID_SUFFIX = '_Valid';

/** A `_Valid` twin is a 32-char non-Unicode RecId pointer — shape, not just name. */
function isValidTwin(property: RawProperty): boolean {
  return (
    property['@_Name'].endsWith(VALID_SUFFIX) &&
    property['@_MaxLength'] === '32' &&
    property['@_Unicode'] === 'false'
  );
}

/** `Collection(MetaData.task)` → `task`; `MetaData.employee` → `employee`; CSDL 3 → `ToRole`. */
function relationshipTarget(navigation: RawNavigationProperty): string {
  const toRole = navigation['@_ToRole'];
  if (toRole !== undefined && toRole !== '') return toRole;

  const type = navigation['@_Type'] ?? '';
  const inner = /Collection\(([^)]+)\)/.exec(type)?.[1] ?? type;
  return inner.slice(inner.lastIndexOf('.') + 1);
}

function toEntityMetadata(raw: RawEntityType): EntityMetadata {
  const properties = raw.Property ?? [];
  const names = new Set(properties.map((property) => property['@_Name']));

  // A twin whose display field is missing — `nrn_CostType_Valid` with no `nrn_CostType` — is an
  // ORPHAN. Hiding it would remove the only evidence that the field is validated at all, so it
  // stays visible even though a well-formed twin does not.
  const hasDisplayField = (name: string): boolean =>
    names.has(name.slice(0, -VALID_SUFFIX.length));

  const validatedNames = new Set(
    properties
      .filter((property) => isValidTwin(property))
      .map((property) => property['@_Name'].slice(0, -VALID_SUFFIX.length)),
  );

  return {
    name: raw['@_Name'],
    fields: properties.map((property) => ({
      name: property['@_Name'],
      type: property['@_Type'] ?? 'Edm.String',
      // CSDL omits Nullable when it is true, so only an explicit "false" is not nullable.
      nullable: property['@_Nullable'] !== 'false',
      validated: validatedNames.has(property['@_Name']),
      internalTwin: isValidTwin(property) && hasDisplayField(property['@_Name']),
    })),
    relationships: (raw.NavigationProperty ?? []).map((navigation) => ({
      name: navigation['@_Name'],
      target: relationshipTarget(navigation),
    })),
  };
}

/**
 * Parses one CSDL document.
 *
 * Throws on anything that is not CSDL rather than returning an empty map: a caller that caches an
 * empty document reports every entity as "not found" for the life of the process, which is how a
 * WAF page or an expired session turns into a permanent, inexplicable outage.
 */
export function parseCsdl(xml: string): CsdlDocument {
  if (!looksLikeCsdl(xml)) {
    throw new Error(`Expected a CSDL $metadata document, got ${xml.slice(0, 80).trim()}…`);
  }

  const parsed = parser.parse(xml) as RawDocument;
  const schemas = parsed.Edmx?.DataServices?.Schema ?? [];

  const entities = new Map<string, EntityMetadata>();
  for (const schema of schemas) {
    for (const raw of schema.EntityType ?? []) {
      // Ivanti FABRICATES an entity type for a name that does not exist: asking for
      // `/api/odata/nonexistents/$metadata` answers 200 with `<EntityType Name="nonexistent" />`
      // and an EntitySet to match. Every real Business Object has at least RecId, so a
      // property-less entity type is Ivanti echoing the typo back rather than a schema.
      if ((raw.Property ?? []).length === 0) continue;
      entities.set(raw['@_Name'].toLowerCase(), toEntityMetadata(raw));
    }
  }

  if (entities.size === 0) {
    throw new Error(
      'CSDL document declares no entity types with fields — Ivanti answers this for an entity ' +
        'set that does not exist, so the name is almost certainly wrong',
    );
  }

  return { entities };
}

/** The fields worth showing a caller: everything but Ivanti's internal `_Valid` pointers. */
export function visibleFields(entity: EntityMetadata): EntityField[] {
  return entity.fields.filter((field) => !field.internalTwin);
}
