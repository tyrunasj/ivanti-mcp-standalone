// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Config } from './env-schema.js';
import { envSchema } from './env-schema.js';
import type { EnvRecord, FileReader } from './read-secret-file.js';
import { readSecret } from './read-secret-file.js';
import { validateConfig } from './validate-config.js';

/** Settings that may also arrive via the `*_FILE` convention. */
const SECRET_KEYS = ['BEARER_TOKEN', 'IVANTI_API_KEY', 'IVANTI_CENTRAL_CONFIG_API_KEY'] as const;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Resolves file-backed secrets, parses the environment, then applies the cross-field
 * rules — in that order, because a rule such as "bearer mode needs a token" cannot be
 * judged until `BEARER_TOKEN_FILE` has been read.
 */
/**
 * An environment variable set to nothing is not set.
 *
 * `docker run -e AUTH_MODE=` is how an operator clears a value inherited from an `--env-file`,
 * and a `.env` line with nothing after the `=` means the same. Treating the empty string as a
 * value makes both of those a startup failure that reads like a typo in the schema.
 */
function withoutEmpty(env: EnvRecord): EnvRecord {
  const kept: EnvRecord = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    kept[key] = value;
  }
  return kept;
}

export function loadConfig(env: EnvRecord, readFile?: FileReader): Config {
  const resolved: EnvRecord = withoutEmpty(env);

  for (const key of SECRET_KEYS) {
    try {
      resolved[key] = readSecret(env, key, readFile);
      delete resolved[`${key}_FILE`];
    } catch (error) {
      throw new ConfigError([error instanceof Error ? error.message : String(error)]);
    }
  }

  const parsed = envSchema.safeParse(resolved);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const problems = validateConfig(parsed.data);
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return parsed.data;
}
