import { readFileSync } from 'node:fs';

/**
 * `package.json` relative to this module.
 *
 * The depth is the same from `src/version.ts` under tsx and from `dist/version.js` under node,
 * because `rootDir: src` maps to `outDir: dist` without adding a level. Keep this module at the
 * root of `src/` or the path breaks.
 */
export const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

export interface PackageMetadata {
  name: string;
  version: string;
}

export type PackageReader = (url: URL) => string;

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
