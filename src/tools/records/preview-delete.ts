import { z } from 'zod';
import { describeFailure, type ActionResult } from '../../ivanti/quick-actions/execute.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { IvantiApiError } from '../../ivanti/http/errors.js';

export function createPreviewDeleteTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'preview_delete',
    title: 'Preview a delete',
    description:
      'Asks Ivanti what deleting a record would take with it, and whether anything blocks it — ' +
      'without deleting.\n\n' +
      'Ivanti cascades: an incident can take its tasks, journals and attachments. Call this ' +
      'before delete_record and tell the person what will go.\n\n' +
      'Read `blockers` rather than the status: a clean preview reports an error status while ' +
      'carrying only warnings, so the status says nothing about whether the delete would work.' +
      '\n\nSOME OBJECTS HAVE NO DELETE PREVIEW and answer a raw 500 (`journal__notes` does). ' +
      'That is not a blocker and not a refusal of the delete — it means Ivanti could not ' +
      'evaluate the cascade. Judge the record yourself; delete_record may well succeed.',
    annotations: {
      title: 'Preview a delete',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object the record belongs to.'),
      recordId: z.string().describe('The 32-character RecId that would be deleted.'),
    },
    handler: (args) =>
      runTool('preview_delete', deps.logger, async () => {
        const { entity } = await resolveObject(deps, args.object);
        const objectId = toObjectId(entity.name);

        // The empty collections mirror what Ivanti's own client sends; PreDeleteObject rejects a
        // leaner shape. `master*` are null because this deletes a record, not a detail-tab child
        // hanging off an open parent.
        /**
         * A 500 here means Ivanti could not EVALUATE the cascade, not that the delete is refused.
         *
         * Some objects have no delete preview at all — `journal__notes` throws a
         * NullReferenceException — and this used to surface as `isError: true` with the words
         * "Ivanti refused the request (500)" and a .NET stack trace. The description said not to
         * read that as a refusal, which is the wrong place to fix it: a caller believes the
         * result over a paragraph read fifty descriptions ago. One tester duly abandoned its
         * cleanup and left a test note on a live customer ticket; `delete_record` then worked
         * first time.
         */
        const result = await deps.connection.session
          .call<ActionResult>(
          'Services/Save.asmx',
          'PreDeleteObject',
          {
            data: {
              [args.recordId]: {
                op: 'delete',
                objectId: args.recordId,
                objectType: objectId,
                values: {},
                valuesOrder: {},
                forceAutoFill: {},
                originalValues: {},
                pureOriginalValues: {},
                attachementCacheIds: {},
                uploadedImageIds: {},
                textFields: [],
                masterObjectType: null,
                masterObjectId: null,
                relationshipTag: null,
              },
            },
          },
          )
          .catch((error: unknown) => {
            if (!(error instanceof IvantiApiError) || error.status < 500) throw error;
            return undefined;
          });

        if (result === undefined) {
          return jsonResult({
            object: entity.name,
            recId: args.recordId,
            previewAvailable: false,
            wouldDelete: null,
            note:
              `Ivanti has no working delete preview for ${entity.name} — it failed while ` +
              'evaluating the cascade. THIS IS NOT A BLOCKER AND NOT A REFUSAL: it says nothing ' +
              'about whether the record can be deleted, and delete_record may well succeed. ' +
              'Judge the record yourself — read it, tell the person what it is, and proceed.',
          });
        }

        const blockers = describeFailure(result);
        const warnings = (result.errors?.warningMessages ?? []).map(String);

        return jsonResult({
          object: entity.name,
          recId: args.recordId,
          wouldDelete: blockers.length === 0,
          ...(blockers.length > 0 ? { blockers } : {}),
          ...(warnings.length > 0 ? { cascades: warnings } : {}),
          note:
            blockers.length === 0
              ? 'Nothing blocks it. Anything under `cascades` goes with the record.'
              : 'Blocked: the delete would fail. Nothing was deleted either way.',
        });
      }),
  });
}
