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
