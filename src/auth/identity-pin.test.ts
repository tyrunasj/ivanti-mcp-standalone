// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import {
  createSessionPin,
  IdentityConflictError,
  initialIdentity,
  VerifiedSessionError,
  type PinnedPerson,
} from './identity-pin.js';
import { ANONYMOUS, verifiedIdentity } from './identity.js';

const VERIFIED = verifiedIdentity({
  subject: '367708',
  issuer: 'https://idp',
  scopes: [],
  claims: { email: 'jsmith@corp.example' },
});

function person(overrides: Partial<PinnedPerson> = {}): PinnedPerson {
  return {
    recId: 'A1',
    category: 'employee',
    displayName: 'John Smith',
    loginId: 'jsmith',
    matchedOn: 'LoginID',
    provenance: 'asserted',
    ...overrides,
  };
}

describe('createSessionPin', () => {
  it('pins the first person and keeps them', () => {
    const pin = createSessionPin(ANONYMOUS);

    pin.pin(person());

    expect(pin.person()?.displayName).toBe('John Smith');
    expect(pin.identity()).toEqual({ provenance: 'asserted', subject: 'jsmith' });
  });

  it('refuses a second, different person rather than switching', () => {
    // The new name may have come from a ticket the conversation just read.
    const pin = createSessionPin(ANONYMOUS);
    pin.pin(person());

    expect(() => pin.pin(person({ recId: 'B2', displayName: 'Ada Dale' }))).toThrow(
      IdentityConflictError,
    );
    expect(pin.person()?.displayName).toBe('John Smith');
  });

  it('accepts the same person again', () => {
    const pin = createSessionPin(ANONYMOUS);
    pin.pin(person());

    expect(() => pin.pin(person({ matchedOn: 'PrimaryEmail' }))).not.toThrow();
    // The first pin stands: a repeat confirms, it does not overwrite.
    expect(pin.person()?.matchedOn).toBe('LoginID');
  });

  it('refuses a claim outright when the session is verified', () => {
    // Not merged, not preferred: otherwise the strong path has a bypass around it.
    const pin = createSessionPin(VERIFIED);

    expect(() => pin.pin(person())).toThrow(VerifiedSessionError);
    expect(pin.person()).toBeUndefined();
  });

  it('lets a verified session pin the person its own token resolved to', () => {
    const pin = createSessionPin(VERIFIED);

    pin.pin(person({ provenance: 'verified' }));

    expect(pin.person()?.recId).toBe('A1');
    // The identity stays the token's: resolving the person adds to what is known about it
    // rather than downgrading how it was established.
    expect(pin.identity()).toBe(VERIFIED);
  });

  it('keeps conversations apart, because the pin is the conversation', () => {
    // stdio has no session id to key a map by, and this is why that no longer matters.
    const first = createSessionPin(ANONYMOUS);
    const second = createSessionPin(ANONYMOUS);

    first.pin(person());
    second.pin(person({ recId: 'B2', displayName: 'Ada Dale' }));

    expect(first.person()?.displayName).toBe('John Smith');
    expect(second.person()?.displayName).toBe('Ada Dale');
  });
});

describe('initialIdentity', () => {
  it('is the verified identity when there is one, and anonymous otherwise', () => {
    expect(initialIdentity(VERIFIED)).toBe(VERIFIED);
    expect(initialIdentity(undefined)).toEqual(ANONYMOUS);
  });
});
