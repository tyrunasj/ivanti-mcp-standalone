// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { readFileSync } from 'node:fs';

export type EnvRecord = Record<string, string | undefined>;

export type FileReader = (path: string) => string;

/**
 * Resolves one setting that may arrive either inline or via the `*_FILE` convention.
 *
 * Container secrets are mounted as files (`/run/secrets/...`) so they never appear in
 * `docker inspect`. Supplying both forms is a configuration mistake, not a precedence
 * question, so it throws rather than silently picking one.
 */
export function readSecret(
  env: EnvRecord,
  key: string,
  readFile: FileReader = (path) => readFileSync(path, 'utf8'),
): string | undefined {
  const inline = env[key];
  const path = env[`${key}_FILE`];

  if (inline !== undefined && path !== undefined) {
    throw new Error(`Both ${key} and ${key}_FILE are set; provide exactly one.`);
  }

  if (path === undefined) return inline;

  const contents = readFile(path).trim();
  if (contents === '') {
    throw new Error(`${key}_FILE points at ${path}, which is empty.`);
  }
  return contents;
}
