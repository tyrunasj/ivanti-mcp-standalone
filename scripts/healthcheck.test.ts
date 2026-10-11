// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../src/config/env-schema.js';

const SCRIPT = fileURLToPath(new URL('../docker/healthcheck.mjs', import.meta.url));

function run(env: Record<string, string>) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

describe('docker/healthcheck.mjs', () => {
  // The script cannot be imported (it exits on load), so its truthy set is read out of its own
  // source and held against the schema the server reads the same flag with.
  const source = readFileSync(SCRIPT, 'utf8');
  const literal = /const httpOn = (\/.+\/[a-z]*)\.test\(/.exec(source)?.[1];

  it('reads the HTTP flag as the server does', () => {
    expect(literal).toBeDefined();
    const parts = /^\/(.*)\/([a-z]*)$/.exec(literal ?? '');
    const rx = new RegExp(parts?.[1] ?? '', parts?.[2]);
    const words = ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', 'y', 'n', 'enabled', 'disabled', 'maybe', ''];
    const candidates = words.flatMap((w) => [w, w.toUpperCase(), ` ${w}`, `${w} `]);
    let compared = 0;
    for (const value of candidates) {
      const parsed = envSchema.shape.HTTP_TRANSPORT_ON.safeParse(value);
      // What the server refuses stops it at boot (exit 78): nothing is left to agree on.
      if (!parsed.success) continue;
      compared += 1;
      expect(rx.test(value), JSON.stringify(value)).toBe(parsed.data);
    }
    expect(compared).toBeGreaterThan(10);
  });

  it('passes without polling when HTTP is off', () => {
    expect(run({ HTTP_TRANSPORT_ON: 'false' }).status).toBe(0);
  });

  it.each(['abc', '0', '-5', '1.5', 'NaN'])('fails loudly on HEALTHCHECK_TIMEOUT_MS=%s', (value) => {
    const r = run({ HTTP_TRANSPORT_ON: 'true', MCP_PORT: '1', HEALTHCHECK_TIMEOUT_MS: value });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('HEALTHCHECK_TIMEOUT_MS');
  });
});
