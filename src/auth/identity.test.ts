// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { ANONYMOUS, assertedIdentity, auditFields, verifiedIdentity } from './identity.js';

describe('CallerIdentity', () => {
  it('distinguishes the three provenances at the type level', () => {
    expect(ANONYMOUS).toEqual({ provenance: 'anonymous' });
    expect(assertedIdentity('jsmith')).toEqual({ provenance: 'asserted', subject: 'jsmith' });
    expect(
      verifiedIdentity({ subject: '367708', issuer: 'https://idp', scopes: [], claims: {} }),
    ).toEqual({ provenance: 'verified', subject: '367708', issuer: 'https://idp' });
  });
});

/**
 * Which claim names the person, and which may not.
 *
 * An `email` the provider did not verify is whatever the user typed into their profile. On an IdP
 * that lets them edit it, the default probe order pinned one employee as a colleague — verified —
 * and under impersonation opened Ivanti's own session as them.
 */
describe('the directory key', () => {
  const token = (claims: Record<string, unknown>) =>
    ({ subject: 's', issuer: 'https://idp', scopes: [], claims });

  it.each([
    ['the boolean', true],
    ['the string some providers send', 'true'],
  ])('takes an email the provider verified, as %s', (_label, flag) => {
    expect(
      verifiedIdentity(token({ email: 'ann@corp.example', email_verified: flag })).directoryKey,
    ).toBe('ann@corp.example');
  });

  it.each([
    ['says it is not verified', { email_verified: false }],
    ['says so as a string', { email_verified: 'false' }],
    ['does not say', {}],
  ])('passes over an email when the provider %s', (_label, flag) => {
    expect(
      verifiedIdentity(token({ email: 'colleague@corp.example', ...flag })).directoryKey,
    ).toBeUndefined();
  });

  it('falls through to the next claim rather than refusing the token', () => {
    expect(
      verifiedIdentity(
        token({ email: 'colleague@corp.example', email_verified: false, preferred_username: 'ann' }),
      ).directoryKey,
    ).toBe('ann');
  });

  // Naming the claim is the operator's decision about what their IdP lets users edit.
  it('takes a configured claim as configured', () => {
    expect(
      verifiedIdentity(token({ email: 'ann@corp.example', email_verified: false }), 'email')
        .directoryKey,
    ).toBe('ann@corp.example');
  });
});

describe('auditFields', () => {
  it('logs a verified subject, because an issuer vouched for it', () => {
    const fields = auditFields(
      verifiedIdentity({ subject: '367708', issuer: 'https://idp', scopes: [], claims: {} }),
    );

    expect(fields).toEqual({ identity: 'verified', subject: '367708' });
  });

  it('never logs an asserted subject as though it were a fact', () => {
    // The claim may have come from ticket text, which anyone can write.
    expect(auditFields(assertedIdentity('jsmith'))).toEqual({ identity: 'asserted' });
  });

  it('says anonymous rather than saying nothing', () => {
    expect(auditFields(ANONYMOUS)).toEqual({ identity: 'anonymous' });
  });
});
