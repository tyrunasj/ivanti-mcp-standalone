// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import {
  confirmWrite,
  resolveValidatedWrite,
  toObjectId,
} from '../../ivanti/write/validated-write.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import { referencedFieldNames } from '../../ivanti/odata/filter.js';
import { describeSubtypes, findSubtypes } from '../../ivanti/metadata/subtypes.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { explainFieldError } from '../shared/explain-field-error.js';
import { explainRequiredFields } from '../shared/explain-required-fields.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { ownershipFields } from '../shared/own-records.js';
import { knownObjectNames } from '../shared/object-names.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { projectWritten } from '../shared/project-written.js';
import { connectionFor } from '../shared/connection-for.js';

export function createCreateRecordTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'create_record',
    title: 'Create a record',
    description:
      'Creates one record and returns what Ivanti actually stored.\n\n' +
      'FIELD NAMES ARE NOT GUESSABLE — an incident\'s description is `Symptom`. Call ' +
      'get_object_metadata first, and get_pick_list_values for any field it marks `validated`: ' +
      'those take a value from a list, and this tool refuses one that is not on it rather than ' +
      'letting Ivanti accept the write and store nothing.\n\n' +
      'A PERSON IS NOT A NAME. A link is always a PAIR — `<Link>_RecID` holding the target\'s ' +
      'RecId and `<Link>_Category` naming the object it lives in — but WHICH link is which ' +
      'differs per object: on an incident the customer is `ProfileLink`, on a service request the ' +
      'same field is labelled "Contact Link", and a change has no `ProfileLink` at all. Call ' +
      'get_link_fields for the object you are writing to rather than reusing a name that worked ' +
      'elsewhere.\n\n' +
      'Creating a child under a parent is the same shape — `ParentLink_RecID` plus ' +
      '`ParentLink_Category` — passed here, in the create, which wires the relationship in one ' +
      'call. link_records is for records that already exist.\n\n' +
      'The record is read back before this reports success. A write Ivanti accepted but did not ' +
      'store is reported as a failure.' +
      (deps.ownRecordsOnly
        ? '\n\nA REQUEST GOES TO THE CATALOG; A FAULT IS AN INCIDENT. "I need a laptop / access" ' +
          'is a request — check list_request_offerings first, for the questions, routing and ' +
          'approvals the tenant encoded. "X is broken / has stopped" is a fault and belongs ' +
          'here, even when an offering shares its name.\n\n' +
          'A REOPEN ACTION BESIDE A CLOSE ACTION IS NOT EVIDENCE THE CLOSE IS REVERSIBLE. ' +
          'Measured: a self-service Close landed on `Closed` while the Reopen accepted only ' +
          '`Resolved`, so whoever can close can never reopen — and the record is then ' +
          'permanently read-only and undeletable. Never promise someone they can undo it.'
        : ''),
    annotations: {
      title: 'Create a record',
      readOnlyHint: false,
      // Additive: it creates, it does not overwrite.
      destructiveHint: false,
      idempotentHint: false,
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
      fields: z
        .record(z.string(), z.unknown())
        .describe('Field names to values, e.g. { "Subject": "Printer jam", "Status": "Logged" }.'),
      returnFields: z
        .string()
        .optional()
        .describe(
          'Comma-separated fields to return in the confirmation. Defaults to the fields you ' +
            'wrote plus a compact identifying set — a whole Ivanti record is ~180 fields and ' +
            'roughly 10 KB of JSON, which is a lot to spend confirming a write that has already ' +
            'been verified. Pass "*" for the whole record.',
        ),
    },
    handler: (args, context) =>
      runTool('create_record', deps.logger, async () => {
        const connection = connectionFor(deps, context);
        const transport = connection.transport;
        const target = await resolveObject(deps, args.object);
        const { entity, entitySet } = target;

        // In `enduser` mode the record is stamped with the caller, and the stamp wins: a ticket
        // filed under someone else's name is the thing this mode exists to prevent.
        const owner = await ownershipFields(deps, context, target);

        // The person's connection, not the service account's: `resolveValidatedWrite` reads the
        // create form, runs `GetFormValidationListData` and reads cascade parents through it. On
        // `deps.connection` those ran as the service account while the write itself went out on the
        // person's SID — so a value only an admin's form offers was accepted, attached to its RecId
        // and stored, then confirmed, and reported as validated for a role that never offers it.
        const resolved = await resolveValidatedWrite({
          connection,
          logger: deps.logger,
          entity,
          entitySet,
          fields: args.fields,
        });

        const body = { ...args.fields, ...resolved.values, ...resolved.companions, ...owner };
        const url = transport.routes.entitySet(entitySet);

        const created = await transport
          .request<OdataRecord>(url, { method: 'POST', body })
          .catch(async (error: unknown) => {
            // A create aimed at a base type answers 500 with an empty message, which explains
            // nothing. The subtypes do.
            const subtypes = findSubtypes(await knownObjectNames(deps.connection), entity.name);
            if (subtypes.length > 0) {
              throw new Error(
                `${describeSubtypes(entity.name, subtypes)} (Ivanti refused this create: ` +
                  `${error instanceof Error ? error.message : 'unknown error'})`,
              );
            }

            // Required-field rules name display names, and some of them are links; the form is
            // the only thing that can translate either.
            const form = await connection.forms
              .get(toObjectId(entity.name))
              .catch(() => undefined);
            throw (
              explainRequiredFields(error, form) ??
              explainFieldError(error, entity, referencedFieldNames({ fields: Object.keys(body) })) ??
              error
            );
          });

        const recId = created?.['RecId'];
        if (typeof recId !== 'string' || recId === '') {
          return errorResult(
            'Ivanti answered the create without a RecId, so there is no evidence a record was ' +
              'stored. Check with list_records before trying again — a retry may duplicate it.',
          );
        }

        // Throws when a value did not take: the record exists, but not as asked.
        await confirmWrite(
          connection,
          entitySet,
          recId,
          resolved.confirm,
          resolved.companions,
          transport,
        );

        deps.logger.info('ivanti record created', { object: entitySet });

        return jsonResult({
          object: entitySet,
          recId,
          ...(Object.keys(owner).length === 0 ? {} : { filedFor: context.pin?.person()?.displayName }),
          record: projectWritten(created, args.returnFields, Object.keys(args.fields)),
        });
      }),
  });
}
