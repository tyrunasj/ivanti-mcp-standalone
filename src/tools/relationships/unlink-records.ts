// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { transportFor } from '../shared/transport-for.js';
import {
  describeUnknownRelationship,
  RELATIONSHIP_OK,
  resolveRelationship,
} from './link-records.js';

export function createUnlinkRecordsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'unlink_records',
    title: 'Unlink two records',
    description:
      'Removes a relationship between two existing records. The records themselves are not ' +
      'deleted.\n\n' +
      'The link is checked first, and this refuses when it is not there. That is not politeness: ' +
      'Ivanti ACCEPTS an unlink of something that was never linked, and on a Contains ' +
      'relationship it severs the target from whichever record IS its parent — damage to a third ' +
      'record that nothing in the reply mentions.\n\n' +
      'Use get_related_records to see what is linked before removing anything.',
    annotations: {
      title: 'Unlink two records',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('The Business Object the source record belongs to.'),
      recordId: z.string().describe('RecId of the source record.'),
      relationship: z.string().describe('Relationship name, e.g. `IncidentContainsTask`.'),
      targetId: z.string().describe('RecId of the record to unlink.'),
    },
    handler: (args, context) =>
      runTool('unlink_records', deps.logger, async () => {
        const transport = transportFor(deps.connection.transport, context);
        const { entity, entitySet } = await resolveObject(deps, args.object);

        const relationship = resolveRelationship(entity.relationships, args.relationship);
        if (relationship === undefined) {
          return errorResult(
            describeUnknownRelationship(entity.name, args.relationship, entity.relationships),
          );
        }

        const relatedUrl = transport.routes.related(
          entitySet,
          args.recordId,
          relationship,
        );
        const linked = readCollection<OdataRecord>(
          await transport.request<OdataRecord>(relatedUrl),
          relatedUrl,
        );

        const isLinked = linked.some(
          (row) => String(row['RecId']).toLowerCase() === args.targetId.toLowerCase(),
        );
        if (!isLinked) {
          return errorResult(
            `${entitySet}('${args.recordId}') is not linked to ${args.targetId} via ` +
              `${relationship}, so nothing was unlinked. Ivanti would have accepted this and, on ` +
              'a Contains relationship, severed the target from whichever record IS its parent. ' +
              'Check with get_related_records first.',
          );
        }

        const url = transport.routes.ref(
          entitySet,
          args.recordId,
          relationship,
          args.targetId,
        );
        const answer = await transport.request<OdataRecord>(url, {
          method: 'DELETE',
        });

        const code = answer?.['code'];
        if (typeof code === 'string' && code !== RELATIONSHIP_OK) {
          return errorResult(`Ivanti refused the unlink with code ${code}.`);
        }

        deps.logger.info('ivanti records unlinked', { object: entitySet, relationship });

        return jsonResult({
          object: entitySet,
          recId: args.recordId,
          relationship,
          unlinked: args.targetId,
        });
      }),
  });
}
