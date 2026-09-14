// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { connectionFixture } from '../connection.fixture.js';
import {
  buildSubmitPayload,
  encodeAnswer,
  readSubmitReply,
  SubmitRefusedError,
  verifyStoredAnswers,
} from './submit.js';

const BASE = {
  transport: connectionFixture({}).connection.transport,
  subscriptionId: 'sub-1',
  personRecId: 'p1',
  localOffset: -120,
};

const reply = (over: Record<string, unknown> = {}) => ({
  IsSuccess: true,
  ErrorText: '',
  ServiceRequests: [
    {
      strRequestRecId: 'sr1',
      strRequestNum: '10219',
      strName: 'Address Change',
      parameterTemplateParameterIds: { a: 'x' },
    },
  ],
  ...over,
});

describe('buildSubmitPayload', () => {
  it('sends all eleven fields, because Ivanti errors on a missing one rather than defaulting it', () => {
    const payload = buildSubmitPayload({ ...BASE, answers: {} });

    expect(Object.keys(payload).sort()).toEqual([
      'attachmentsToDelete',
      'attachmentsToUpload',
      'delayedFulfill',
      'formName',
      'localOffset',
      'parameters',
      'saveReqState',
      'serviceReqData',
      'strCustomerLocation',
      'strUserId',
      'subscriptionId',
    ]);
  });

  it('writes a combo as a value and a sibling -recId key', () => {
    // A bare value is refused: "validation list's value was submitted without it's identifier".
    const payload = buildSubmitPayload({
      ...BASE,
      answers: { P1: { value: 'IT', recId: 'opt-9' } },
    });

    expect(payload['parameters']).toEqual({ 'par-P1': 'IT', 'par-P1-recId': 'opt-9' });
  });

  it('prefixes a bare parameter id, and leaves an already-prefixed one alone', () => {
    const payload = buildSubmitPayload({ ...BASE, answers: { P1: 'a', 'par-P2': 'b' } });

    expect(payload['parameters']).toEqual({ 'par-P1': 'a', 'par-P2': 'b' });
  });

  it('encodes a checkbox as the only string Ivanti stores', () => {
    // Measured: `true`, `'True'` and `1` all leave the field false while echoing the sent value
    // back, so the request reads as correct and is not.
    expect(encodeAnswer(true)).toBe('true');
    expect(encodeAnswer(false)).toBe('false');
    // Anything else is left alone: without the parameter's DisplayType a bare 1 could equally
    // belong to a number field.
    expect(encodeAnswer(1)).toBe(1);
    expect(encodeAnswer('True')).toBe('True');
  });
});

describe('readSubmitReply', () => {
  it('refuses a 200 that carries IsSuccess false', () => {
    // Ivanti delivers a refusal inside a successful HTTP response; nothing was created.
    expect(() =>
      readSubmitReply({ IsSuccess: false, ErrorText: "Parameter 'Department': Required" }, 1),
    ).toThrow(SubmitRefusedError);
    expect(() => readSubmitReply({ IsSuccess: false, ErrorText: 'x' }, 1)).toThrow(
      /Nothing was created/,
    );
  });

  it('explains the combo refusal in terms of what to do about it', () => {
    expect(() =>
      readSubmitReply(
        {
          IsSuccess: false,
          ErrorText: "'Department' validation list's value was submitted without it's identifier.",
        },
        1,
      ),
    ).toThrow(/get_service_request_parameter_options/);
  });

  it('refuses a success that names no request', () => {
    expect(() => readSubmitReply({ IsSuccess: true, ServiceRequests: [] }, 0)).toThrow(
      /no evidence one exists/,
    );
  });

  it('raises the mismatched-template trap rather than reporting a clean submit', () => {
    // The request exists with none of the answers on it, which Ivanti calls success.
    expect(() =>
      readSubmitReply(reply({ ServiceRequests: [{ strRequestRecId: 'sr1', strRequestNum: '1', parameterTemplateParameterIds: {} }] }), 3),
    ).toThrow(/NONE of the 3 answers were applied/);
  });

  it('reports what Ivanti says it mapped, alongside what was sent', () => {
    const submitted = readSubmitReply(reply(), 1);

    expect(submitted.requestNumber).toBe('10219');
    expect(submitted.recId).toBe('sr1');
    expect(submitted.parametersOnRequest).toBe(1);
    expect(submitted.parametersSent).toBe(1);
  });
});

describe('verifyStoredAnswers', () => {
  const withStored = (rows: Record<string, unknown>[]) =>
    connectionFixture({
      entities: { servicereq: {} },
      responses: { ServiceReqContainsServiceReqParam: { value: rows } },
    }).connection.transport;

  it('accepts a datetime that differs only in precision', async () => {
    const check = await verifyStoredAnswers(
      withStored([
        {
          ParameterName: 'ValidFrom',
          ParameterValue: '2026-09-30T00:00:00.0000000Z',
          SvcReqTmplParamLink_RecID: 'P1',
        },
      ]),
      'sr1',
      { P1: '2026-09-30T00:00:00Z' },
    );

    expect(check).toEqual({ mismatches: [], missing: [] });
  });

  it('accepts a date stored as the UTC instant of local midnight', async () => {
    // Ivanti stores `2026-10-01` on a UTC+2 tenant as 2026-09-30T22:00Z. That is correct, and
    // calling it a mismatch sent a tester into a second, non-idempotent submit to "fix" it.
    const check = await verifyStoredAnswers(
      withStored([
        {
          ParameterName: 'ValidFrom',
          ParameterValue: '2026-09-30T22:00:00.0000000Z',
          SvcReqTmplParamLink_RecID: 'P1',
        },
      ]),
      'sr1',
      { P1: '2026-10-01' },
      -120,
    );

    expect(check).toEqual({ mismatches: [], missing: [] });
  });

  it('accepts a bare date stored at the offset in force on that date, not today', async () => {
    // The clocks change between the record the offset was read from and the date being stored:
    // `2026-11-01` submitted in September stores as 2026-10-31T23:00Z — local midnight at the
    // winter offset. Correct, and an instant comparison called it a mismatch.
    const check = await verifyStoredAnswers(
      withStored([
        {
          ParameterName: 'ValidFrom',
          ParameterValue: '2026-10-31T23:00:00.0000000Z',
          SvcReqTmplParamLink_RecID: 'P1',
        },
      ]),
      'sr1',
      { P1: '2026-11-01' },
      -120,
    );

    expect(check).toEqual({ mismatches: [], missing: [] });
  });

  it('still catches a bare date that landed on the wrong day', async () => {
    const check = await verifyStoredAnswers(
      withStored([
        {
          ParameterName: 'ValidFrom',
          ParameterValue: '2026-09-28T22:00:00.0000000Z',
          SvcReqTmplParamLink_RecID: 'P1',
        },
      ]),
      'sr1',
      { P1: '2026-09-30' },
      -120,
    );

    expect(check.mismatches).toHaveLength(1);
  });

  it('catches a date that landed on the wrong day', async () => {
    // What a wrong localOffset does, and the only way to see it: Ivanti reports the submit clean.
    const check = await verifyStoredAnswers(
      withStored([
        {
          ParameterName: 'ValidFrom',
          ParameterValue: '2026-09-29T22:00:00.0000000Z',
          SvcReqTmplParamLink_RecID: 'P1',
        },
      ]),
      'sr1',
      { P1: '2026-09-30T00:00:00Z' },
      0,
    );

    expect(check.mismatches).toEqual([
      { parameter: 'ValidFrom', sent: '2026-09-30T00:00:00Z', stored: '2026-09-29T22:00:00.0000000Z' },
    ]);
  });

  it('catches a checkbox Ivanti declined to store', async () => {
    const check = await verifyStoredAnswers(
      withStored([
        { ParameterName: 'ForwardEmail', ParameterValue: 'false', SvcReqTmplParamLink_RecID: 'P1' },
      ]),
      'sr1',
      { P1: true },
    );

    expect(check.mismatches[0]).toMatchObject({ sent: 'true', stored: 'false' });
  });

  it('names an answer that reached no parameter at all', async () => {
    const check = await verifyStoredAnswers(withStored([]), 'sr1', { P1: 'x' });

    expect(check.missing).toEqual(['p1']);
  });

  it('compares a combo on its value, not its identifier', async () => {
    const check = await verifyStoredAnswers(
      withStored([
        { ParameterName: 'Department', ParameterValue: 'IT', SvcReqTmplParamLink_RecID: 'P1' },
      ]),
      'sr1',
      { P1: { value: 'IT', recId: 'opt-9' } },
    );

    expect(check).toEqual({ mismatches: [], missing: [] });
  });
});
