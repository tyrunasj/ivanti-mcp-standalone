// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { ResolvedForm } from './form-context.js';

/**
 * A `ResolvedForm` built from the parts a test cares about.
 *
 * Hand-built literals are how four test files broke at once when `Config` grew five keys
 * (see notes, "Testing"), and `ResolvedForm` has now grown twice for the same reason. A fixture
 * means the next field is added in one place.
 */
export function formFixture(overrides: Partial<ResolvedForm> = {}): ResolvedForm {
  return {
    layoutName: 'IncidentLayout',
    viewName: 'NewIncident',
    formName: 'Incident.Default',
    validatedFields: {},
    displayNames: {},
    fieldLabels: {},
    linkFields: {},
    requiredRuleFields: [],
    readOnlyFields: [],
    ...overrides,
  };
}
