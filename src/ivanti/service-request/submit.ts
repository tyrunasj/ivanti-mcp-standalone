// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { IvantiTransport } from '../http/transport.js';
import type { IvantiSession } from '../session/asmx-session.js';
import type { StagedAttachment } from './stage-attachment.js';
import type { OdataRecord } from '../odata/response.js';
import { readCollection } from '../odata/response.js';

/**
 * Submitting a service request, which Ivanti will tell you went fine when it did not.
 *
 * Every failure mode here was measured on a live tenant (2026-09-12):
 *
 * - **A refused submit answers HTTP 200** with `IsSuccess: false` and the reason in `ErrorText`.
 *   Nothing is created. Judging on the status code reports a failure as a success.
 * - **A combo parameter needs its option's RecId as a sibling key** — `par-<id>` holds the value
 *   and `par-<id>-recId` the option. Without it: *"'Department' validation list's value was
 *   submitted without it's identifier."* (Ivanti's own apostrophes.)
 * - **A datetime is converted from local wall time using `localOffset`, which must be the tenant
 *   offset NEGATED.** On a UTC+2 tenant, sending `2026-09-30T00:00:00Z` stored:
 *   `localOffset: -120` → `2026-09-30T00:00:00Z` (right), `0` → `2026-09-29T22:00:00Z` (a day
 *   early), and `+120` → **`0001-01-01T00:00:00`** — the value destroyed, and still
 *   `IsSuccess: true`.
 * - **A checkbox stores only the exact lowercase string `'true'`.** `true`, `'True'`, `1` leave it
 *   false while echoing the sent value back, so the request reads as correct and is not.
 */

/** Ivanti's submit envelope. A 200 carrying `IsSuccess: false` means nothing was created. */
interface SubmitReply {
  IsSuccess?: unknown;
  ErrorText?: unknown;
  ServiceRequests?: unknown;
}

interface CreatedRequest {
  strRequestRecId?: unknown;
  strRequestNum?: unknown;
  strName?: unknown;
  /** Template parameter RecId → the parameter instance created on the request. */
  parameterTemplateParameterIds?: unknown;
}

/** Ivanti's default service request form, overridable for a tenant with a custom layout. */
const DEFAULT_FORM = 'ServiceReq.ResponsiveAnalyst.DefaultLayout';

/** Matches an ISO-8601 instant or a bare date, which is what needs the offset applied. */
export const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** A combo answer: the value the person chose, and the option's own identifier. */
export interface ChosenOption {
  value: string;
  recId: string;
}

export type ParameterAnswer = string | number | boolean | ChosenOption;

export function isChosenOption(value: unknown): value is ChosenOption {
  return typeof value === 'object' && value !== null && 'recId' in value;
}

/**
 * A checkbox stores only `'true'`. A JSON boolean is how a model naturally answers one, so that
 * is the encoding worth rescuing; anything else is left alone, because without the parameter's
 * DisplayType a bare `1` could equally belong to a number field.
 */
export function encodeAnswer(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}

export interface SubmitRequest {
  transport: IvantiTransport;
  subscriptionId: string;
  /** The requesting person's RecId — `Frs_CompositeContract_Contacts`, which shares it. */
  personRecId: string;
  answers: Record<string, ParameterAnswer>;
  /** The tenant's UTC offset in minutes, already negated by the caller. */
  localOffset: number;
  formName?: string;
  subject?: string;
  customerLocation?: string;
}

export function buildSubmitPayload(request: SubmitRequest): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};

  for (const [id, answer] of Object.entries(request.answers)) {
    const key = id.startsWith('par-') ? id : `par-${id}`;
    if (isChosenOption(answer)) {
      // Empty must be '' and never null: Ivanti dereferences a null option value even for a
      // parameter it does not require.
      parameters[key] = encodeAnswer(answer.value);
      parameters[`${key}-recId`] = answer.recId;
    } else {
      parameters[key] = encodeAnswer(answer);
    }
  }

  const serviceReqData: Record<string, string> = {};
  if (request.subject !== undefined && request.subject !== '') {
    serviceReqData['Subject'] = request.subject;
  }

  // All eleven fields are mandatory — Ivanti errors on a missing one rather than defaulting it.
  return {
    attachmentsToDelete: [],
    attachmentsToUpload: [],
    parameters,
    delayedFulfill: false,
    saveReqState: false,
    formName: request.formName ?? DEFAULT_FORM,
    serviceReqData,
    strCustomerLocation: request.customerLocation ?? '',
    strUserId: request.personRecId,
    subscriptionId: request.subscriptionId,
    localOffset: request.localOffset,
  };
}

export class SubmitRefusedError extends Error {
  constructor(reason: string) {
    super(
      `The service request was NOT submitted: ${reason}. Nothing was created. Ivanti names one ` +
        'missing parameter at a time, so expect another name after fixing this one — check ' +
        'every parameter whose `required` is true against what you sent.',
    );
    this.name = 'SubmitRefusedError';
  }
}

export interface SubmittedRequest {
  requestNumber: string;
  recId: string;
  name?: string;
  /** Ivanti's own mapping count. It includes template defaults, so it can exceed what was sent. */
  parametersOnRequest: number;
  parametersSent: number;
}

export function readSubmitReply(reply: unknown, sentCount: number): SubmittedRequest {
  const envelope = (reply ?? {}) as SubmitReply;
  const error = typeof envelope.ErrorText === 'string' ? envelope.ErrorText : '';

  if (/validation list.s value was submitted without it.s identifier/i.test(error)) {
    throw new SubmitRefusedError(
      `${error} That parameter is a combo, and every combo needs the chosen option's ` +
        'identifier alongside its value — resolve it with get_service_request_parameter_options ' +
        'and pass `{ value, recId }` rather than a bare value',
    );
  }

  if (envelope.IsSuccess !== true) {
    throw new SubmitRefusedError(error === '' ? 'Ivanti gave no reason' : error);
  }

  const created = Array.isArray(envelope.ServiceRequests)
    ? (envelope.ServiceRequests[0] as CreatedRequest | undefined)
    : undefined;
  const recId = typeof created?.strRequestRecId === 'string' ? created.strRequestRecId : undefined;
  const requestNumber =
    typeof created?.strRequestNum === 'string' ? created.strRequestNum : undefined;

  if (recId === undefined || requestNumber === undefined) {
    throw new SubmitRefusedError(
      'Ivanti reported success but named no request, so there is no evidence one exists',
    );
  }

  const mapped = created?.parameterTemplateParameterIds;
  const applied = mapped !== null && typeof mapped === 'object' ? Object.keys(mapped).length : 0;

  // Ivanti accepts parameter RecIds that belong to a different template and creates the request
  // with none of them applied. subscriptionId and templateId are different ids for the same
  // offering, and mixing two offerings' ids is the way to get here.
  if (sentCount > 0 && applied === 0) {
    throw new Error(
      `Service request ${requestNumber} was created, but NONE of the ${String(sentCount)} ` +
        'answers were applied — Ivanti mapped no parameters. That means the parameter ids do ' +
        "not belong to this subscription's template: take `templateId` and `subscriptionId` " +
        'from the SAME list_request_offerings entry. The request now exists with no answers on ' +
        'it and should be cancelled in Ivanti.',
    );
  }

  return {
    requestNumber,
    recId,
    ...(typeof created?.strName === 'string' ? { name: created.strName } : {}),
    parametersOnRequest: applied,
    parametersSent: sentCount,
  };
}

export interface StoredAnswer {
  parameter: string;
  sent: string;
  stored: string;
}

/** `2026-09-30T00:00:00.0000000Z` and `2026-09-30T00:00:00Z` are the same instant. */
function comparable(value: unknown): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return text
    .trim()
    .replace(/\.0+(?=Z?$)/, '')
    .replace(/Z$/, '')
    .toLowerCase();
}

/**
 * Whether a stored datetime is the one that was sent, once the tenant's offset is undone.
 *
 * Ivanti stores a date as the **UTC instant of local midnight**, so `2026-10-01` comes back from a
 * UTC+2 tenant as `2026-09-30T22:00:00Z`. That is correct, and a string comparison calls it a
 * mismatch — which reported a clean submit as `answersVerified: false` and sent a tester into a
 * second, non-idempotent submit to "fix" a date that was already right. Duplicating a service
 * request is a worse outcome than the warning was ever worth.
 *
 * `localOffset` is the tenant offset **negated**, so adding its inverse converts the stored
 * instant back to the local wall time the caller meant.
 */
function sameMoment(sent: string, stored: string, localOffset: number): boolean {
  const storedAt = Date.parse(stored);
  if (Number.isNaN(storedAt)) return false;

  const tenantOffset = -localOffset;

  // A bare date is a DATE: it asks for a day, not an instant, and Ivanti stores the day's local
  // midnight. Compare the day it lands on rather than the instant — and allow the clocks to have
  // changed between the record the offset was read from and the date being stored. Measured:
  // `2026-11-01` submitted in September stored as `2026-10-31T23:00Z`, which is local midnight on
  // 1 November at the winter offset and entirely correct; comparing instants called it a
  // mismatch, and a mismatch on a correct write is what sends a caller into a duplicate submit.
  if (/^\d{4}-\d{2}-\d{2}$/.test(sent)) {
    for (const drift of [0, 60, -60]) {
      const local = new Date(storedAt + (tenantOffset + drift) * 60_000);
      if (local.toISOString().slice(0, 10) === sent) return true;
    }
    return false;
  }

  // An explicit instant is compared as one, exactly — but in the TENANT's frame, not the host's.
  //
  // The tool asks for `YYYY-MM-DDTHH:MM` in the tenant's local time, and ECMAScript resolves a
  // zone-less date-TIME string in whatever zone the server process happens to run in (a date-ONLY
  // string is UTC, which is why the branch above never had this problem). So the same submit
  // verified differently depending on where the process ran: on a host in the tenant's own
  // timezone — the documented deployment, "beside the tenant it talks to" — a correctly stored
  // value came back as `storedDifferently`, and a false mismatch on a correct write is exactly
  // what sends a caller into a second, non-idempotent submit.
  //
  // Appending `Z` when the caller supplied no zone reads their wall clock as the tenant's, which
  // is what they were asked for. A value that DOES carry a zone or offset is respected as given.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(sent);
  const sentAt = Date.parse(zoned ? sent : `${sent}Z`);
  return !Number.isNaN(sentAt) && storedAt - localOffset * 60_000 === sentAt;
}

/**
 * Reads the request back and says which answers did not land.
 *
 * Ivanti reports a submit as successful without checking that the answers stored, and three of
 * the traps above are invisible in the reply — a flipped checkbox, a date shifted by the offset
 * and a dropped parameter all look identical to a clean submit until the request is read.
 */
export async function verifyStoredAnswers(
  transport: IvantiTransport,
  requestRecId: string,
  answers: Record<string, ParameterAnswer>,
  /** The offset the submit used, so a date stored as local midnight is not read as a mismatch. */
  localOffset = 0,
): Promise<{ mismatches: StoredAnswer[]; missing: string[] }> {
  const wanted = new Map<string, unknown>();
  for (const [id, answer] of Object.entries(answers)) {
    const key = id.replace(/^par-/, '').toLowerCase();
    wanted.set(key, isChosenOption(answer) ? answer.value : answer);
  }

  const url = transport.routes.related(
    'servicereqs',
    requestRecId,
    'ServiceReqContainsServiceReqParam',
  );
  const rows = readCollection<OdataRecord>(await transport.request<OdataRecord>(url), url);

  const stored = new Map(
    rows.map((row) => {
      const link = row['SvcReqTmplParamLink_RecID'];
      return [typeof link === 'string' ? link.toLowerCase() : '', row] as const;
    }),
  );

  const mismatches: StoredAnswer[] = [];
  const missing: string[] = [];

  for (const [id, value] of wanted) {
    const row = stored.get(id);
    if (row === undefined) {
      missing.push(id);
      continue;
    }
    const want = comparable(encodeAnswer(value));
    const got = comparable(row['ParameterValue']);
    const storedText = typeof row['ParameterValue'] === 'string' ? row['ParameterValue'] : '';
    const sentText = typeof value === 'string' ? value : '';

    // A datetime is compared as an instant, never as text.
    const datesAgree =
      ISO_DATETIME.test(sentText) && sameMoment(sentText, storedText, localOffset);

    if (want !== '' && want !== got && !datesAgree) {
      mismatches.push({
        parameter: typeof row['ParameterName'] === 'string' ? row['ParameterName'] : id,
        sent: String(encodeAnswer(value)),
        stored: typeof row['ParameterValue'] === 'string' ? row['ParameterValue'] : '',
      });
    }
  }

  return { mismatches, missing };
}

const SUBSCRIPTION_SERVICE = 'ServiceCatalog/services/ServiceSubscription.asmx';

/**
 * The submit that binds staged files, which is a different endpoint from the one that does not.
 *
 * REST's `/ServiceRequest/new` accepts an `attachments` field and **silently drops it**, so a
 * request with files would come back looking correct and carry nothing. Only the ASMX
 * `SubmitRequestForUser` binds them.
 *
 * Two oddities, both verified rather than reasoned about. `GetPackageDataSDA` has to run again
 * immediately before the submit — the staged ids outlive the session that made them, but the
 * submit refuses them without it. And the two location fields are **not** what their names
 * suggest: `strCustomerLocation` carries the form name (`ServiceReqHeader.New`), which is the
 * shape that works.
 */
export async function submitWithAttachments(
  session: IvantiSession,
  request: SubmitRequest,
  attachments: readonly StagedAttachment[],
): Promise<unknown> {
  const payload = buildSubmitPayload(request);

  await session.call(SUBSCRIPTION_SERVICE, 'GetPackageDataSDA', {
    strSubscrRecId: request.subscriptionId,
    customerLocation: request.customerLocation ?? '',
  });

  return session.call<unknown>(SUBSCRIPTION_SERVICE, 'SubmitRequestForUser', {
    subscriptionId: request.subscriptionId,
    serviceReqDraftId: null,
    parameters: payload['parameters'],
    attachmentsToDelete: [],
    // A pair per file, in the order Ivanti reads them: the staging id, then the name.
    attachmentsToUpload: attachments.map((file) => [file.attachmentId, file.filename]),
    strUserId: request.personRecId,
    strOrgUnit: null,
    strCustomerLocation: 'ServiceReqHeader.New',
    formName: '',
    serviceReqData: {},
    delayedFulfill: false,
    saveReqState: false,
  });
}
