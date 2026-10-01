// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { registry } from './server-metrics.js';

/**
 * One sample's value as a scrape would read it — 0 when absent. The registry is process-wide, so
 * a test compares before and after rather than asserting an absolute count.
 */
export function sample(name: string, labels: Record<string, string> = {}): number {
  const wanted = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  const prefix = wanted === '' ? `${name} ` : `${name}{${wanted}} `;
  const line = registry
    .render()
    .split('\n')
    .find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? 0 : Number(line.slice(prefix.length));
}
