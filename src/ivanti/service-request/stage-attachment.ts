// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { IvantiApiError } from '../http/errors.js';
import type { IvantiSession } from '../session/asmx-session.js';

/**
 * Staging a file for a request that does not exist yet.
 *
 * A service request's attachments are collected on the **form**, before the request is created —
 * there is no record to hang them off yet. So the file goes to Ivanti's staging area first and the
 * submit binds it. Only the ASMX submit does: REST's `/ServiceRequest/new` accepts an
 * `attachments` field and silently drops it, so a request would come back looking correct with
 * nothing attached.
 *
 * **A staging token is one-shot.** Ivanti keeps a single attachment record behind it, so a second
 * submit would *move* the file off the first request rather than copy it. Stage the file again
 * for a second request.
 *
 * Three calls, and the order is load-bearing: `GetPackageDataSDA` establishes the subscription
 * context on the session, `GetUploadTicket` mints the ticket, and only then will the handler
 * accept the bytes.
 */

const SUBSCRIPTION_SERVICE = 'ServiceCatalog/services/ServiceSubscription.asmx';

/** The self-service upload handler, which answers with a JavaScript object literal. */
const UPLOAD_HANDLER = 'SelfService/handlers/UploadAttachmentHandler.ashx';

/**
 * `{ attachmentIds:[ { filename:"x.txt" ,attachmentId:"CE16…" } ] ,attachmentId:"CE16…" }`
 *
 * Unquoted keys and leading commas — the ExtJS dialect the workspace grid also speaks. Matching
 * the pair directly is steadier than converting the whole document to JSON: the only thing worth
 * reading is inside these braces, and a filename may contain anything a filename may contain.
 */
const STAGED = /\{\s*filename\s*:\s*"([^"]*)"\s*,\s*attachmentId\s*:\s*"([^"]+)"\s*\}/g;

export interface StagedAttachment {
  attachmentId: string;
  filename: string;
}

export interface StageAttachmentRequest {
  session: IvantiSession;
  /** The offering being requested — staging is scoped to it. */
  subscriptionId: string;
  /** The requester's location; Ivanti scopes the staging session by it. `''` when unknown. */
  customerLocation: string;
  filename: string;
  bytes: Uint8Array;
  contentType: string;
}

export async function stageAttachment(
  request: StageAttachmentRequest,
): Promise<StagedAttachment> {
  const { session, subscriptionId, filename } = request;

  // The session side effect first: without it the ticket is minted but the handler refuses it.
  await session.call(SUBSCRIPTION_SERVICE, 'GetPackageDataSDA', {
    strSubscrRecId: subscriptionId,
    customerLocation: request.customerLocation,
  });

  const ticket = await session.call<string>(SUBSCRIPTION_SERVICE, 'GetUploadTicket', {});
  if (typeof ticket !== 'string' || ticket === '') {
    throw new IvantiApiError(
      { status: 200, method: 'POST', url: SUBSCRIPTION_SERVICE },
      'Ivanti issued no upload ticket, so there is nowhere to stage the file.',
    );
  }

  const form = new FormData();
  form.append('file', new Blob([request.bytes], { type: request.contentType }), filename);
  // The request does not exist yet, so there is no id to attach to.
  form.append('objectId', '');
  form.append('objectType', 'ServiceReq#');
  form.append('UploadTicket', ticket);
  form.append('multiplefiles', 'true');

  const body = await session.uploadToHandler(UPLOAD_HANDLER, form);

  const match = STAGED.exec(body);
  STAGED.lastIndex = 0;

  if (match === null || match[2] === undefined) {
    throw new IvantiApiError(
      { status: 200, method: 'POST', url: UPLOAD_HANDLER, body: body.slice(0, 300) },
      `Ivanti accepted '${filename}' but answered without a staging id, so there is nothing the ` +
        'submit could bind. Nothing was attached.',
    );
  }

  return {
    attachmentId: match[2],
    filename: match[1] === undefined || match[1] === '' ? filename : match[1],
  };
}
