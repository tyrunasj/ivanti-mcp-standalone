// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * `package.json` relative to this module.
 *
 * The depth is the same from `src/version.ts` under tsx and from `dist/version.js` under node,
 * because `rootDir: src` maps to `outDir: dist` without adding a level. Keep this module at the
 * root of `src/` or the path breaks.
 */
export const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

export const SDK_PACKAGE = '@modelcontextprotocol/sdk';

export interface PackageMetadata {
  name: string;
  version: string;
}

export type PackageReader = (url: URL | string) => string;

const defaultReader: PackageReader = (url) => readFileSync(url, 'utf8');

/**
 * Reads the server's own name and version from `package.json`, so that the manifest is the
 * single source of truth and `get_version` cannot drift from the published artifact.
 *
 * Throws rather than falling back to a placeholder: reporting a wrong version is worse than
 * failing to start, because it makes a deployment impossible to identify.
 */
export function readPackageMetadata(read: PackageReader = defaultReader): PackageMetadata {
  let parsed: unknown;

  try {
    parsed = JSON.parse(read(PACKAGE_JSON_URL));
  } catch (error) {
    throw new Error(
      `Could not read ${PACKAGE_JSON_URL.pathname}. ` +
        'A container image must copy package.json alongside dist/.',
      { cause: error },
    );
  }

  const record = parsed as Record<string, unknown>;

  if (typeof record.name !== 'string' || record.name === '') {
    throw new Error('package.json has no usable "name".');
  }
  if (typeof record.version !== 'string' || record.version === '') {
    throw new Error('package.json has no usable "version".');
  }

  return { name: record.name, version: record.version };
}

/**
 * The version of the MCP SDK actually installed.
 *
 * Cannot be read via `require('@modelcontextprotocol/sdk/package.json')`: the SDK's `exports`
 * map has a `./*` entry that resolves it to `dist/cjs/package.json`, which contains only
 * `{"type":"commonjs"}`. So resolve a real module and walk up to the package root instead.
 *
 * Diagnostic rather than load-bearing, so an unreadable manifest degrades to `unknown` instead
 * of stopping the server — unlike our own version, where misidentifying the build is worse.
 */
export function readSdkVersion(read: PackageReader = defaultReader): string {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve(`${SDK_PACKAGE}/server/mcp.js`));

    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const manifest = JSON.parse(read(join(dir, 'package.json'))) as {
          name?: unknown;
          version?: unknown;
        };
        if (manifest.name === SDK_PACKAGE && typeof manifest.version === 'string') {
          return manifest.version;
        }
      } catch {
        // Not the package root yet, or not readable — keep walking.
      }

      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Resolution failed entirely.
  }

  return 'unknown';
}
