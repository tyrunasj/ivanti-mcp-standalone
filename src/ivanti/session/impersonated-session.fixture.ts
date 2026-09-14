// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { ImpersonatedSession } from './impersonated-session.js';

/**
 * Test-only `ImpersonatedSession` builder, for the reason `capabilityFixture` and `configFixture`
 * exist: a member added to the type must not break every test that hand-built one. Four test
 * files did, and `callHandler` broke all four at once.
 *
 * Every call rejects by default. A test that exercises a call stubs the one it means to.
 */
export const impersonatedSessionFixture = (
  overrides: Partial<ImpersonatedSession> = {},
): ImpersonatedSession => {
  const role = overrides.role ?? 'ServiceDeskAnalyst';
  return {
    sid: 'tenant.example.com#FIXTURE#1',
    loginId: 'HSanders',
    role,
    roles: [],
    call: () => Promise.reject(new Error('unused in this fixture')),
    callHandler: () => Promise.reject(new Error('unused in this fixture')),
    uploadToHandler: () => Promise.reject(new Error('unused in this fixture')),
    identity: () => Promise.resolve({ role }),
    identityIfKnown: () => ({ role }),
    switchTo: () => Promise.reject(new Error('unused in this fixture')),
    release: () => Promise.resolve(),
    ...overrides,
  };
};
