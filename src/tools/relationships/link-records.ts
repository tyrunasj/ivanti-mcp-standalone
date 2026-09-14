// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { suggestNames } from '../../ivanti/metadata/suggest-names.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/** Ivanti's "it worked" code on the relationship endpoints. Anything else is a failure in a 200. */
export const RELATIONSHIP_OK = 'ISM_2000';

export function resolveRelationship(
  known: readonly { name: string }[],
  requested: string,
): string | undefined {
  return known.find((entry) => entry.name.toLowerCase() === requested.toLowerCase())?.name;
}

export function describeUnknownRelationship(
  entityName: string,
  requested: string,
  known: readonly { name: string }[],
): string {
  const names = known.map((entry) => entry.name);
  const close = suggestNames(requested, names, 5);
  return (
    `${entityName} has no relationship named '${requested}'. ` +
    (close.length > 0
      ? `Did you mean: ${close.join(', ')}?`
      : `It has ${String(names.length)}: ${names.slice(0, 15).join(', ')}${names.length > 15 ? ', …' : ''}`) +
    ' Full list: get_object_metadata.'
  );
}

export function createLinkRecordsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'link_records',
    title: 'Link two records',
    description:
      'Links an existing record to another across a named relationship — attaching a task to an ' +
      'incident, associating a CI with a change.\n\n' +
      'This is for records that ALREADY EXIST. Creating a child under a parent is done in ' +
      'create_record instead, with `ParentLink_RecID` and `ParentLink_Category` in the same call.\n\n' +
      'Relationship names come from get_object_metadata and are Ivanti-specific ' +
      '(`IncidentContainsTask`). Ivanti answers a relationship failure with 200 and a code, so ' +
      'this checks the code rather than the status.',
    annotations: {
      title: 'Link two records',
      readOnlyHint: false,
      // Additive: it adds a relationship, it does not remove or overwrite one.
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('The Business Object the source record belongs to.'),
      recordId: z.string().describe('RecId of the source record.'),
      relationship: z.string().describe('Relationship name, e.g. `IncidentContainsTask`.'),
      targetId: z.string().describe('RecId of the record to link to.'),
    },
    handler: (args) =>
      runTool('link_records', deps.logger, async () => {
        const { entity, entitySet } = await resolveObject(deps, args.object);

        const relationship = resolveRelationship(entity.relationships, args.relationship);
        if (relationship === undefined) {
          return errorResult(
            describeUnknownRelationship(entity.name, args.relationship, entity.relationships),
          );
        }

        const url = deps.connection.transport.routes.ref(
          entitySet,
          args.recordId,
          relationship,
          args.targetId,
        );
        const answer = await deps.connection.transport.request<OdataRecord>(url, {
          method: 'PATCH',
        });

        const code = answer?.['code'];
        if (typeof code === 'string' && code !== RELATIONSHIP_OK) {
          return errorResult(
            `Ivanti refused the link with code ${code}. Check that both records exist and that ` +
              `${relationship} accepts a ${String(entity.relationships.find((r) => r.name === relationship)?.target)}.`,
          );
        }

        deps.logger.info('ivanti records linked', { object: entitySet, relationship });

        return jsonResult({ object: entitySet, recId: args.recordId, relationship, linked: args.targetId });
      }),
  });
}
