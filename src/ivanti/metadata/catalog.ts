// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import { parseCsdl, type CsdlDocument, type EntityMetadata } from './csdl.js';
import { toCsdlEntity, toEnglishSingular, toGuessedEntitySet } from './entity-names.js';
import { IvantiApiError } from '../http/errors.js';
import { suggestNames, toStem } from './suggest-names.js';
import type { IvantiTransport } from '../http/transport.js';

/**
 * Raised when no CSDL document knows the entity. Carries suggestions, because the usual cause is
 * an English plural (`Categories` for `Categorys`) and Ivanti's own answer to that is an empty
 * result rather than an error.
 */
export class UnknownEntityError extends Error {
  readonly entity: string;
  readonly suggestions: string[];

  constructor(entity: string, suggestions: string[]) {
    const tail =
      suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : ' No similarly named entity exists in the metadata this key can read.';
    super(`Ivanti has no Business Object named '${entity}'.${tail}`);
    this.name = 'UnknownEntityError';
    this.entity = entity;
    this.suggestions = suggestions;
  }
}

/**
 * Graph roots worth reading to build a Business Object catalog without a session.
 *
 * A CSDL graph names the entities *related* to its root, so no single document lists the tenant.
 * Measured live: incidents alone names 38 entities, these eight together name 200, in under a
 * second. The full ~1300-entry admin list needs `/HEAT/AdminUI/`, which an analyst key is
 * refused — so this is the widest catalog an ordinary key can reach.
 */
export const WELL_KNOWN_GRAPHS = [
  'incidents',
  'employees',
  'changes',
  'tasks',
  'problems',
  'servicereqs',
  'journals',
  'cis',
] as const;

export interface MetadataCatalog {
  /** Field and relationship metadata for one entity, in any of the three naming dialects. */
  entity: (ref: string) => Promise<EntityMetadata>;
  /** Every entity name the catalog has seen, lowercase, sorted. */
  entityNames: () => Promise<string[]>;
  /** Parses one more graph into the catalog, widening it. Undefined when the graph is unusable. */
  graph: (entitySet: string) => Promise<CsdlDocument | undefined>;
  /** Reads every well-known graph once, so `entityNames` answers for the tenant, not one graph. */
  widen: () => Promise<void>;
}

export interface MetadataCatalogDeps {
  transport: IvantiTransport;
  /** The CSDL URL the startup probe found — the graph everything else is discovered from. */
  seedUrl: string;
  logger: Logger;
  /**
   * More names to suggest from, when the credential sees further than the metadata graphs — the
   * admin console knows 1324 objects where the graphs know 194. Suggestions only: what `entity()`
   * can resolve is unchanged.
   */
  suggestionNames?: () => Promise<string[]>;
}

/**
 * The tenant's schema, read through `$metadata` and cached for the process lifetime.
 *
 * Three Ivanti behaviours shape this module, all measured live:
 *
 * 1. **A graph names many entities but describes relationships for only one.** In the incidents
 *    graph, `task` has 90 fields and *zero* relationships; in `tasks/$metadata` it has the same
 *    90 fields and 29 relationships. So a relationship-less hit is not an answer, it is a reason
 *    to fetch the entity's own graph.
 * 2. **An unknown entity set is not an error.** Ivanti answers 200 with a fabricated, field-less
 *    entity type, which `parseCsdl` drops — so "no usable document" is how a typo arrives here.
 * 3. **A non-CSDL 200 must never be cached.** A WAF page or a login redirect cached as metadata
 *    makes every entity report "not found" for the life of the process.
 */
export function createMetadataCatalog(deps: MetadataCatalogDeps): MetadataCatalog {
  const { transport, seedUrl, logger, suggestionNames } = deps;
  const documents = new Map<string, Promise<CsdlDocument | undefined>>();

  const fetchDocument = (url: string): Promise<CsdlDocument | undefined> => {
    const existing = documents.get(url);
    if (existing !== undefined) return existing;

    const pending = (async (): Promise<CsdlDocument | undefined> => {
      try {
        const document = parseCsdl(await transport.requestText(url));
        logger.debug('csdl parsed', { url, entities: document.entities.size });
        return document;
      } catch (error: unknown) {
        // A connection failure is not an answer: forget it so the next caller tries again. Any
        // reply from Ivanti — including the fabricated empty document — is cached as "no", so a
        // mistyped entity costs one round trip rather than one per call.
        const transportFailure = error instanceof IvantiApiError && error.status === 0;
        if (transportFailure) documents.delete(url);
        logger.debug('csdl unavailable', {
          url,
          retryable: transportFailure,
          reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
        });
        return undefined;
      }
    })();

    documents.set(url, pending);
    return pending;
  };

  const resolved = async (): Promise<CsdlDocument[]> => {
    const all = await Promise.all([...documents.values()]);
    return all.filter((document): document is CsdlDocument => document !== undefined);
  };

  const entityNames = async (): Promise<string[]> => {
    await fetchDocument(seedUrl);
    const names = new Set<string>();
    for (const document of await resolved()) {
      for (const name of document.entities.keys()) names.add(name);
    }

    if (names.size === 0) {
      throw new Error(
        `Ivanti's $metadata could not be read at ${seedUrl}, so no Business Object is known. ` +
          'Every schema-dependent tool depends on it.',
      );
    }

    return [...names].sort((a, b) => a.localeCompare(b));
  };

  return {
    entityNames,

    async widen(): Promise<void> {
      // Independent documents, so fetch them together: eight round trips in series would be the
      // slowest thing the server does.
      await Promise.all(
        WELL_KNOWN_GRAPHS.map((graph) => fetchDocument(transport.routes.metadata(graph))),
      );
    },

    graph: (entitySet: string): Promise<CsdlDocument | undefined> =>
      fetchDocument(transport.routes.metadata(entitySet)),

    async entity(ref: string): Promise<EntityMetadata> {
      /**
       * The name as given first, then the singularised guess.
       *
       * `toCsdlEntity` strips a trailing `s`, which is right for `Incidents` and wrong for any
       * object whose own CSDL name ends in one. `journal__notes` — the extension an end user
       * writes a note to — became `journal__note`, so the catalog handed out a name its own
       * tools then refused, suggesting the name it had just been given. The graph was even
       * fetched correctly and the answer thrown away on the wrong key.
       *
       * Trying the exact name first costs nothing: a name that is already an entity is found,
       * and a set name like `Incidents` simply misses and falls through to the guess.
       */
      const candidates = [ref.toLowerCase(), toCsdlEntity(ref).toLowerCase()];
      const lookup = (document: CsdlDocument | undefined): EntityMetadata | undefined => {
        for (const name of candidates) {
          const found = document?.entities.get(name);
          if (found !== undefined) return found;
        }
        return undefined;
      };

      const shared = lookup(await fetchDocument(seedUrl));
      if (shared !== undefined && shared.relationships.length > 0) return shared;

      /**
       * Which graph to ask for, with the same ambiguity in the other direction.
       *
       * An entity set is the entity name plus a literal `s`, so `journal__notes` lives in
       * `journal__notess`. `toGuessedEntitySet` will not add an `s` to a name that already ends
       * in one — right for `Incidents`, wrong here — so both are tried. The second is fetched
       * only when the first missed, and a graph that does not exist is cached as a miss.
       */
      const graphs = [...new Set([toGuessedEntitySet(ref), `${ref.toLowerCase()}s`])];

      // Either the seed graph does not name it, or it named it without relationships — which is
      // what every non-root entity looks like there.
      for (const graph of graphs) {
        const own = lookup(await fetchDocument(transport.routes.metadata(graph)));
        if (own !== undefined) return own;
      }

      // The shared graph's fields are complete even when its relationships are absent, so a
      // stale-but-real answer beats failing.
      if (shared !== undefined) return shared;

      // A caller who pluralised the English way asked for a set that does not exist, and the
      // object they want may be in no graph fetched so far — so `Categories` would otherwise
      // produce no suggestion at all. Undo the English plural and look the real one up: one
      // extra round trip, on the failure path only, to turn "no such object" into its name.
      const singular = toEnglishSingular(ref);
      if (singular !== undefined) {
        const corrected = await fetchDocument(
          transport.routes.metadata(toGuessedEntitySet(singular)),
        );
        const match = corrected?.entities.get(singular.toLowerCase());
        if (match !== undefined) {
          throw new UnknownEntityError(ref, [toGuessedEntitySet(singular)]);
        }
      }

      // Stem both dialects: the caller may have said `Categories` (English plural of the set)
      // or `Categorie#` (English plural of the AdminUI id), and only one of the two stems
      // reaches `category`.
      const suggestions = await entityNames()
        .then(async (names) => {
          const extra = await (suggestionNames?.() ?? Promise.resolve([])).catch(() => []);
          return [...new Set([...names, ...extra])];
        })
        .then((names) => {
          const stems = new Set([toStem(toCsdlEntity(ref)), toStem(ref)]);
          const ranked = [...stems].flatMap((stem) => suggestNames(stem, names, 3));
          return [...new Set(ranked)].slice(0, 3);
        })
        .catch(() => []);
      throw new UnknownEntityError(ref, suggestions);
    },
  };
}
