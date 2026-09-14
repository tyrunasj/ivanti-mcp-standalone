/**
 * Refuses a release whose git tag disagrees with `package.json`.
 *
 * `src/version.ts` reads the manifest at startup and the server refuses to boot without it, so
 * the version in the image is whatever `package.json` says — not what the tag says. Let the two
 * drift and you ship `tyrunas/ivanti-mcp:1.2.3` whose `/health` reports something else, which is
 * exactly the kind of thing nobody notices until an incident.
 *
 *   node scripts/check-version.mjs v1.2.3
 */
import { readFileSync } from 'node:fs';

const tag = (process.argv[2] ?? '').trim();
if (tag === '') {
  console.error('usage: node scripts/check-version.mjs <git tag>');
  process.exit(2);
}

const wanted = tag.replace(/^v/, '');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (version !== wanted) {
  console.error(
    `Tag ${tag} does not match package.json.\n` +
      `  tag says:          ${wanted}\n` +
      `  package.json says: ${version}\n\n` +
      'The server reports its version from package.json, so publishing this would ship an image ' +
      'that misreports what it is. Fix package.json (and the lockfile) or retag.',
  );
  process.exit(1);
}

console.log(`version ok: ${version}`);
