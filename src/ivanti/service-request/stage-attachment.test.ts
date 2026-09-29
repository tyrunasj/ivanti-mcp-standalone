// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { IvantiApiError } from '../http/errors.js';
import type { IvantiSession } from '../session/asmx-session.js';
import { stageAttachment } from './stage-attachment.js';

/**
 * A session that records every call in order and answers from `answers`.
 *
 * Staging is three calls whose ORDER is the behaviour — the ticket is refused unless the package
 * call ran first — so the log is what these tests read.
 */
function session(answers: {
  ticket?: unknown;
  upload?: string | Error;
  packageData?: Error;
}) {
  const log: string[] = [];
  const forms: FormData[] = [];
  const stub: IvantiSession = {
    call: <T>(_service: string, method: string) => {
      log.push(method);
      if (method === 'GetPackageDataSDA' && answers.packageData !== undefined) {
        return Promise.reject(answers.packageData);
      }
      return Promise.resolve((method === 'GetUploadTicket' ? answers.ticket : undefined) as T);
    },
    callHandler: () => Promise.reject(new Error('unused')),
    uploadToHandler: (path: string, form: FormData) => {
      log.push(path);
      forms.push(form);
      return answers.upload instanceof Error
        ? Promise.reject(answers.upload)
        : Promise.resolve(answers.upload ?? '');
    },
    identity: () => Promise.resolve({ role: 'Admin', displayName: 'Service Account' }),
    identityIfKnown: () => undefined,
  };
  return { stub, log, forms };
}

const stage = (stub: IvantiSession, filename = 'quote.txt') =>
  stageAttachment({
    session: stub,
    subscriptionId: 'sub-1',
    customerLocation: '',
    filename,
    bytes: new TextEncoder().encode('quote'),
    contentType: 'text/plain',
  });

/** The handler's ExtJS dialect: unquoted keys and leading commas. */
const REPLY =
  '{ attachmentIds:[ { filename:"quote.txt" ,attachmentId:"CE16AB" } ] ,attachmentId:"CE16AB" }';

describe('stageAttachment', () => {
  it('runs the three calls in the order Ivanti requires, and reads the staging id', async () => {
    const { stub, log, forms } = session({ ticket: 'ticket-1', upload: REPLY });

    const staged = await stage(stub);

    expect(staged).toEqual({ attachmentId: 'CE16AB', filename: 'quote.txt' });
    expect(log).toEqual([
      'GetPackageDataSDA',
      'GetUploadTicket',
      'SelfService/handlers/UploadAttachmentHandler.ashx',
    ]);
    // No request exists yet, so there is nothing to attach to — only the object type.
    const form = forms[0];
    expect(form?.get('objectId')).toBe('');
    expect(form?.get('objectType')).toBe('ServiceReq#');
    expect(form?.get('UploadTicket')).toBe('ticket-1');
    expect(form?.get('multiplefiles')).toBe('true');
    expect((form?.get('file') as File | null)?.name).toBe('quote.txt');
  });

  it('keeps the name Ivanti echoed, and falls back to ours when it echoed none', async () => {
    const renamed = session({
      ticket: 't',
      upload: '{ attachmentIds:[ { filename:"quote (1).txt" ,attachmentId:"AA" } ] }',
    });
    const unnamed = session({
      ticket: 't',
      upload: '{ attachmentIds:[ { filename:"" ,attachmentId:"BB" } ] }',
    });

    expect(await stage(renamed.stub)).toEqual({ attachmentId: 'AA', filename: 'quote (1).txt' });
    expect(await stage(unnamed.stub)).toEqual({ attachmentId: 'BB', filename: 'quote.txt' });
  });

  it('can stage one file after another — the reply pattern keeps no state between calls', async () => {
    // The pattern is global, so a `lastIndex` left behind would make every second call miss.
    const { stub } = session({ ticket: 't', upload: REPLY });

    await stage(stub);

    await expect(stage(stub)).resolves.toMatchObject({ attachmentId: 'CE16AB' });
  });

  it('refuses when Ivanti issues no ticket, and sends no bytes', async () => {
    const { stub, log } = session({ ticket: '' });

    await expect(stage(stub)).rejects.toThrow(IvantiApiError);
    await expect(stage(stub)).rejects.toThrow(/issued no upload ticket/);
    expect(log.some((entry) => entry.endsWith('.ashx'))).toBe(false);
  });

  it('refuses a ticket that is not a string', async () => {
    const { stub } = session({ ticket: { d: null } });

    await expect(stage(stub)).rejects.toThrow(/issued no upload ticket/);
  });

  it('refuses a reply that carries no staging id, because the submit would have nothing to bind', async () => {
    const { stub } = session({ ticket: 't', upload: '{ attachmentIds:[] }' });

    await expect(stage(stub)).rejects.toThrow(/answered without a staging id/);
  });

  it('passes an upload failure through, untouched', async () => {
    const { stub } = session({ ticket: 't', upload: new Error('handler answered 551') });

    await expect(stage(stub)).rejects.toThrow('handler answered 551');
  });

  it('mints no ticket when the package call fails', async () => {
    const { stub, log } = session({ ticket: 't', packageData: new Error('session expired') });

    await expect(stage(stub)).rejects.toThrow('session expired');
    expect(log).toEqual(['GetPackageDataSDA']);
  });
});
