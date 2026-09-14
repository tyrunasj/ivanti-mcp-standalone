// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { toEntitySet } from '../../ivanti/metadata/entity-names.js';
import type { AdminBusinessObject } from '../../ivanti/session/admin-catalog.js';
import type { WorkspaceObject } from '../../ivanti/session/workspaces.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/** `audit_incident`, `audit_employee`, … — one shadow table per audited object. */
const AUDIT_PREFIX = 'audit_';

/** A search can reach everything; without one the answer stays readable. */
const MAX_RESULTS = 150;

interface CatalogEntry {
  object: string;
  entitySet: string;
  displayName?: string;
  description?: string;
  commonlyUsed?: boolean;
  validationList?: boolean;
  onWorkspace?: boolean;
}

/**
 * Three sources, widest first, merged into one row per object.
 *
 * The admin console knows every object (1324 on a live tenant) with display names and
 * descriptions; the metadata graphs know ~194 without them; the role's workspaces know the two
 * dozen people actually work in. Which of the three answer depends on the credential, so the
 * result says which it used — a list of 194 and a list of 1324 mean different things when the
 * model concludes an object "does not exist".
 */
function merge(
  metadataNames: readonly string[],
  adminObjects: readonly AdminBusinessObject[],
  workspaceObjects: readonly WorkspaceObject[],
): Map<string, CatalogEntry> {
  const entries = new Map<string, CatalogEntry>();

  const entry = (object: string): CatalogEntry => {
    const existing = entries.get(object);
    if (existing !== undefined) return existing;
    const created = { object, entitySet: toEntitySet(`${object}#`) };
    entries.set(object, created);
    return created;
  };

  for (const name of metadataNames) entry(name);

  for (const admin of adminObjects) {
    const row = entry(admin.object);
    row.displayName = admin.displayName;
    if (admin.description !== undefined) row.description = admin.description;
    if (admin.commonlyUsed) row.commonlyUsed = true;
    if (admin.validationList) row.validationList = true;
  }

  for (const workspace of workspaceObjects) {
    const row = entry(workspace.object);
    row.onWorkspace = true;
    row.displayName ??= workspace.displayName;
  }

  return entries;
}

export function createListBusinessObjectsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'list_business_objects',
    title: 'List Business Objects',
    description:
      'Finds the Business Objects (record types) this tenant has, with the entity-set name the ' +
      'record tools take. Start here when you do not know what an object is called — Ivanti ' +
      'names are tenant-specific and rarely what you would guess.\n\n' +
      'WITHOUT a search it returns the short list: the objects on the role\'s workspaces and the ' +
      'ones Ivanti marks as commonly used — what people actually work in. WITH a search it looks ' +
      'across the whole catalog, which on a real tenant is over a thousand objects.\n\n' +
      'Validation lists (`IncidentStatus#`, `Categorys` — the objects that exist to hold picklist ' +
      'values) and audit shadow tables are left out unless you ask for them.\n\n' +
      'The `source` field says how complete this list is AND whether it is a boundary. Where ' +
      'it reports the catalog "narrowed to the objects this deployment allows", that narrowing ' +
      'IS enforced — every other tool refuses an object outside it. Where it does not, this is ' +
      'only what the credential can see in the schema, and permissions are still applied per ' +
      'request.',
    annotations: {
      title: 'List Business Objects',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      search: z
        .string()
        .optional()
        .describe('Case-insensitive substring, matched against the name and the display name.'),
      includeValidationLists: z
        .boolean()
        .optional()
        .describe('Include picklist-backing objects such as `IncidentStatus#`.'),
      includeAuditTables: z.boolean().optional().describe('Include audit_* shadow tables.'),
    },
    handler: (args) =>
      runTool('list_business_objects', deps.logger, async () => {
        const { capability, metadata, workspaces, admin } = deps.connection;

        await metadata.widen();
        const metadataNames = await metadata.entityNames();

        // Both of these only enrich, so neither failure may cost the caller the catalog.
        const adminObjects =
          capability.tier === 'admin'
            ? await admin.list().catch((error: unknown) => {
                deps.logger.warn('admin catalog unavailable', {
                  reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
                });
                return [];
              })
            : [];

        const workspaceObjects =
          capability.tier === 'odata'
            ? []
            : await workspaces.list().catch((error: unknown) => {
                deps.logger.warn('workspace catalog unavailable', {
                  reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
                });
                return [];
              });

        const all = [...merge(metadataNames, adminObjects, workspaceObjects).values()];
        // In enduser mode the catalog is the allowlist: listing objects the caller may not touch
        // only invites requests this server will refuse.
        const entries = all.filter((row) => deps.gate.allows(row.object));
        const search = args.search?.toLowerCase();

        const matching = entries.filter((row) => {
          if (args.includeAuditTables !== true && row.object.startsWith(AUDIT_PREFIX)) return false;
          if (args.includeValidationLists !== true && row.validationList === true) return false;
          if (search !== undefined) {
            return (
              row.object.includes(search) ||
              (row.displayName?.toLowerCase().includes(search) ?? false)
            );
          }
          // No search: the objects people work in, rather than a thousand rows of schema. A
          // gated deployment has few enough that the list itself is the answer.
          if (deps.gate.allowed.length > 0) return true;
          return row.onWorkspace === true || row.commonlyUsed === true;
        });

        const shown = matching.slice(0, MAX_RESULTS);

        return jsonResult({
          source:
            adminObjects.length > 0
              ? deps.gate.allowed.length > 0
                ? 'admin console, narrowed to the objects this deployment allows — NOT the ' +
                  'whole catalog'
                : 'admin console — the complete catalog'
              : workspaceObjects.length > 0
                ? 'role workspaces and OData metadata — wide, but not the whole tenant'
                : 'OData metadata only — wide, but not the whole tenant',
          knownObjects: entries.length,
          returned: shown.length,
          ...(matching.length > shown.length ? { truncated: matching.length } : {}),
          ...(search === undefined
            ? {
                note:
                  'These are the objects in daily use. Pass `search` to look through all ' +
                  `${String(entries.length)}.`,
              }
            : {}),
          /**
           * This tool's own note, NOT the shared one.
           *
           * The shared `zeroNote` explains Ivanti's keyword index and tells the reader to re-ask
           * with an `eq` filter. Neither applies here: `search` is a local substring match over
           * names this server already holds, and there is no filter to re-ask with. Ninety words
           * of correct-sounding advice about the wrong mechanism, with the one load-bearing
           * sentence last, where truncation eats it first.
           */
          ...(shown.length === 0
            ? {
                note:
                  (deps.gate.allowed.length === 0
                    ? ''
                    : `THIS DEPLOYMENT LISTS ONLY ${deps.gate.allowed.join(', ')}. An object ` +
                      'that exists on the tenant but is outside that list does not appear here ' +
                      'at all, so an empty answer can mean "exists but not exposed" — say that ' +
                      'rather than that the object does not exist. ') +
                  (args.search === undefined
                    ? 'No objects to list.'
                    : `No object name or display name contains '${args.search}'. This is a ` +
                      'plain substring match over names, not a search of record content — so ' +
                      'this is about what the catalog is called, and says nothing about whether ' +
                      'any records exist. Try a shorter fragment.'),
              }
            : {}),
          objects: shown,
        });
      }),
  });
}
