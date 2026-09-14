// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Capability } from './capability.js';

/**
 * Test-only `Capability` builder, for the reason `configFixture` exists: a field added to the
 * type must not break every test that happens to need one. Four files hand-built a `Config` and
 * five new `OAUTH_*` keys broke all four at once; `canImpersonate` did the same to seven
 * `Capability` literals before this existed.
 *
 * The defaults are the ordinary deployment: the OData tier, no impersonation.
 */
export const capabilityFixture = (overrides: Partial<Capability> = {}): Capability => ({
  tier: 'odata',
  canImpersonate: false,
  ...overrides,
});
