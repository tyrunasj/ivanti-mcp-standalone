// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { connectionFor } from '../shared/connection-for.js';

interface WorkspaceSearchData {
  SearchData?: {
    favorites?: { Id?: string; Name?: string; isDefault?: boolean }[] | null;
  } | null;
}

/** A saved search whose name starts with "My" resolves against the signed-in account. */
export function answersForSignedInAccount(name: string): boolean {
  return /^my\b/i.test(name.trim());
}

export function createListSavedSearchesTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'list_saved_searches',
    title: 'List saved searches',
    description:
      'The saved searches an Ivanti user would see on an object — "All Active Incidents", ' +
      '"All Incidents Not Closed". They are the tenant\'s own definitions of the questions it ' +
      'asks, so running one is usually better than inventing a filter.\n\n' +
      (deps.connection.capability.canImpersonate
        ? // Replaced, not appended: the sentence below is false wherever act_as has opened a session.
          'Names beginning "My" resolve against the SESSION. After act_as that is the person, and ' +
          'the entry says `answersFor` with their login; before it, the service account, marked ' +
          '`answersForServiceAccount` — then use list_assigned_work instead.\n\n'
        : 'Names beginning "My" are marked `answersForServiceAccount`. Those resolve against the ' +
          'account this server signs in as — not the person asking — so running one answers a ' +
          'question nobody asked. For a named person use list_assigned_work.\n\n') +
      'Pass a name and its `id` to saved_search to run it.',
    annotations: {
      title: 'List saved searches',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z
        .string()
        .describe(
          'Business Object, in any of the three forms Ivanti spells them — the AdminUI id, the ' +
            'entity set, or the entity (`Incident#` / `Incidents` / `incident`, and the same ' +
            'shape for a Business Object this tenant defined itself). Names are tenant-specific: ' +
            'take them from list_business_objects rather than assuming the ones Ivanti ships.',
        ),
    },
    handler: (args, context) =>
      runTool('list_saved_searches', deps.logger, async () => {
        const connection = connectionFor(deps, context);
        const impersonating = context.impersonation?.session()?.loginId;
        const { entity } = await resolveObject(deps, args.object);
        const objectId = toObjectId(entity.name);
        const form = await connection.forms.get(objectId);

        if (form === undefined) {
          return errorResult(
            `Ivanti has no workspace for ${entity.name} that this role can reach, and saved ` +
              'searches belong to a workspace. list_records with a filter does the same job.',
          );
        }

        const workspace = await connection.session.call<WorkspaceSearchData>(
          'Services/Workspace.asmx',
          'GetWorkspaceData',
          { ObjectId: objectId, LayoutName: form.layoutName },
        );

        const searches = (workspace.SearchData?.favorites ?? [])
          .filter(
            (favorite): favorite is { Id: string; Name: string; isDefault?: boolean } =>
              typeof favorite.Id === 'string' && typeof favorite.Name === 'string',
          )
          .map((favorite) => ({
            name: favorite.Name,
            id: favorite.Id,
            ...(favorite.isDefault === true ? { isDefault: true } : {}),
            // "My …" resolves against the SESSION. Under impersonation that is the person, and
            // the flag must say so — a model told "service account" would refuse a search that
            // now answers exactly the question that was asked.
            ...(answersForSignedInAccount(favorite.Name)
              ? impersonating === undefined
                ? { answersForServiceAccount: true }
                : { answersFor: impersonating }
              : {}),
          }));

        return jsonResult({ object: entity.name, count: searches.length, searches });
      }),
  });
}
