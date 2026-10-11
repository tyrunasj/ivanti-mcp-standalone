// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { observeIvantiRequests } from './observe-ivanti.js';

// Vitest setup: production wires this in `index.ts`; tests that count requests need it too.
observeIvantiRequests();
