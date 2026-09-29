// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isIvantiNotFound } from '../../ivanti/http/errors.js';
import type { IvantiTransport } from '../../ivanti/http/transport.js';
import { UnknownEntityError } from '../../ivanti/metadata/catalog.js';
import { suggestNames } from '../../ivanti/metadata/suggest-names.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { readRows } from '../shared/read-rows.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { transportFor } from '../shared/transport-for.js';

/** Ivanti's "it worked" code on the relationship endpoints. Anything else is a failure in a 200. */
export const RELATIONSHIP_OK = 'ISM_2000';

/**
 * A parent/child relationship: Ivanti's `<Parent>Contains<Child>`.
 *
 * The child holds the link itself, in its own `ParentLink_RecID` / `ParentLink_Category`, so it
 * has ONE parent — which is why unlinking one that is not there severs it from the real parent
 * (`unlink_records`), and why linking one that already has a parent MOVES it. Measured on
 * attachments, whose relationship is exactly that view over the pair (`docs/notes.md`).
 */
const CONTAINMENT = /contains/i;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Where the record being linked hangs today, read off the record itself. */
type Child =
  /** Its object is not in the catalog, or has no parent link: nothing here can be moved. */
  | { kind: 'unknown' }
  | { kind: 'missing'; entitySet: string }
  | { kind: 'free'; entitySet: string }
  | { kind: 'parented'; entitySet: string; parentRecId: string; parentCategory?: string };

async function readChild(
  deps: IvantiToolDeps,
  transport: IvantiTransport,
  target: string,
  targetId: string,
): Promise<Child> {
  let resolved;
  try {
    resolved = await resolveObject(deps, target);
  } catch (error: unknown) {
    if (error instanceof UnknownEntityError) return { kind: 'unknown' };
    throw error;
  }

  // Only "not there" is an answer. Any other failure leaves the guard unevaluated, and a guard
  // that cannot be evaluated refuses the write rather than disabling itself.
  const row = await transport
    .request<OdataRecord>(transport.routes.record(resolved.entitySet, targetId))
    .catch((error: unknown) => {
      if (isIvantiNotFound(error)) return undefined;
      throw error;
    });
  if (row === undefined) return { kind: 'missing', entitySet: resolved.entitySet };

  const hasLink =
    'ParentLink_RecID' in row ||
    resolved.entity.fields.some((field) => field.name === 'ParentLink_RecID');
  if (!hasLink) return { kind: 'unknown' };

  const parentRecId = text(row['ParentLink_RecID']);
  if (parentRecId === undefined) return { kind: 'free', entitySet: resolved.entitySet };

  const parentCategory = text(row['ParentLink_Category']);
  return {
    kind: 'parented',
    entitySet: resolved.entitySet,
    parentRecId,
    ...(parentCategory === undefined ? {} : { parentCategory }),
  };
}

/** The current parent's own Contains relationship to this object, so the refusal is runnable. */
async function relationshipFrom(
  deps: IvantiToolDeps,
  parentCategory: string,
  target: string,
): Promise<string | undefined> {
  try {
    const parent = await deps.connection.metadata.entity(parentCategory);
    return parent.relationships.find(
      (candidate) =>
        candidate.target.toLowerCase() === target.toLowerCase() && CONTAINMENT.test(candidate.name),
    )?.name;
  } catch {
    return undefined;
  }
}

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
    handler: (args, context) =>
      runTool('link_records', deps.logger, async () => {
        const transport = transportFor(deps.connection.transport, context);
        const { entity, entitySet } = await resolveObject(deps, args.object);

        const relationship = resolveRelationship(entity.relationships, args.relationship);
        if (relationship === undefined) {
          return errorResult(
            describeUnknownRelationship(entity.name, args.relationship, entity.relationships),
          );
        }

        const target = entity.relationships.find((r) => r.name === relationship)?.target;
        // Not a refusal: re-running a batch after a partial failure depends on a link that is
        // already there answering cleanly (docs/notes.md, 2026-09-28). Just not as "linked".
        const unchanged = (why: string): CallToolResult =>
          jsonResult({
            object: entitySet,
            recId: args.recordId,
            relationship,
            targetId: args.targetId,
            alreadyLinked: true,
            note: `Nothing was changed: ${why}.`,
          });

        // On a Contains relationship the child has ONE parent, held on the child. Linking a child
        // that already has another parent does not add a link — it MOVES the child, severing it
        // from a third record that nothing in Ivanti's answer mentions. The tool is annotated
        // additive, so that has to be refused here, before the PATCH.
        const child =
          target !== undefined && CONTAINMENT.test(relationship)
            ? await readChild(deps, transport, target, args.targetId)
            : undefined;

        if (child?.kind === 'missing') {
          return errorResult(
            `No ${child.entitySet} record with RecId ${args.targetId}, so nothing was linked.`,
          );
        }

        if (child?.kind === 'parented') {
          if (sameId(child.parentRecId, args.recordId)) {
            return unchanged(`${args.targetId} already has this record as its parent`);
          }
          const from = child.parentCategory ?? 'another record';
          const unlinkVia =
            child.parentCategory === undefined || target === undefined
              ? undefined
              : await relationshipFrom(deps, child.parentCategory, target);
          return errorResult(
            `${child.entitySet} ${args.targetId} already belongs to ${from} ` +
              `${child.parentRecId}. ${relationship} is a parent/child relationship and a record ` +
              'has ONE parent, so linking it here would silently MOVE it off that one — Ivanti ' +
              'would answer success and nothing would say the other record lost it. Nothing was ' +
              'changed. If the person wants it moved, unlink it from its current parent first' +
              (unlinkVia === undefined || child.parentCategory === undefined
                ? ' with unlink_records'
                : `: unlink_records({ object: '${child.parentCategory}', recordId: ` +
                  `'${child.parentRecId}', relationship: '${unlinkVia}', targetId: ` +
                  `'${args.targetId}' })`) +
              ', and link it here after.',
          );
        }

        // Any other relationship: a link that is already there answers as such, not as "linked".
        // Best effort — the list is only for the wording, so a failed read just links.
        if (child === undefined || child.kind === 'unknown') {
          const relatedUrl = transport.routes.related(entitySet, args.recordId, relationship);
          const linked = await transport
            .request<OdataRecord>(relatedUrl)
            .then((payload) => readRows<OdataRecord>(payload, relatedUrl))
            .catch(() => [] as OdataRecord[]);
          const there = linked.some(
            (row) => typeof row['RecId'] === 'string' && sameId(row['RecId'], args.targetId),
          );
          if (there) {
            return unchanged(`${args.targetId} is already linked to this record via ${relationship}`);
          }
        }

        const url = transport.routes.ref(
          entitySet,
          args.recordId,
          relationship,
          args.targetId,
        );
        const answer = await transport.request<OdataRecord>(url, {
          method: 'PATCH',
        });

        const code = answer?.['code'];
        if (typeof code === 'string' && code !== RELATIONSHIP_OK) {
          return errorResult(
            `Ivanti refused the link with code ${code}. Check that both records exist and that ` +
              `${relationship} accepts a ${String(target)}.`,
          );
        }

        // A parent/child link is readable on the child, so it is read back: Ivanti's success
        // code is not evidence that the child now names this record.
        if (child?.kind === 'free' && target !== undefined) {
          const after = await readChild(deps, transport, target, args.targetId).catch(
            (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
          );
          if (after instanceof Error) {
            return errorResult(
              `Ivanti accepted the link, but reading ${args.targetId} back failed: ` +
                `${after.message.slice(0, 200)}. So it is not confirmed. Check with ` +
                'get_related_records; linking again is safe, and answers "already linked" if it ' +
                'took.',
            );
          }
          if (after.kind !== 'parented' || !sameId(after.parentRecId, args.recordId)) {
            return errorResult(
              `Ivanti answered the link with ${RELATIONSHIP_OK}, but ${args.targetId} does not ` +
                'name this record as its parent when read back, so it is NOT linked. Do not ' +
                'report it as done.',
            );
          }
        }

        deps.logger.info('ivanti records linked', { object: entitySet, relationship });

        return jsonResult({ object: entitySet, recId: args.recordId, relationship, linked: args.targetId });
      }),
  });
}
