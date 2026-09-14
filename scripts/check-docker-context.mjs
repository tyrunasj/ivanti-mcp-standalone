/**
 * Every `COPY` source in the Dockerfile is really in the build context.
 *
 * `.dockerignore` and the Dockerfile are edited independently, and a COPY whose
 * source is excluded fails ONLY at build time — with "failed to compute cache
 * key: not found", which reads like a missing file rather than an ignored one.
 * There is no Docker daemon in the default dev loop here, so that lands in CI
 * minutes later instead of in the editor. This checks it in milliseconds.
 *
 * Adding `THIRD-PARTY-NOTICES.md` to the image cost exactly that round trip:
 * `*.md` was excluded, `README.md` had a negation, the new file did not.
 *
 *   node scripts/check-docker-context.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const dockerfile = readFileSync(`${ROOT}docker/Dockerfile`, 'utf8');
const patterns = readFileSync(`${ROOT}.dockerignore`, 'utf8')
  .split('\n').map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'));

/** Docker's rule: the LAST matching pattern decides, and `!` re-includes. */
function excluded(path) {
  let verdict = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (matches(pattern, path)) verdict = !negated;
  }
  return verdict;
}

function matches(pattern, path) {
  const rx = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '(?:.*/)?')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')}(?:/.*)?$`,
  );
  return rx.test(path);
}

const problems = [];
for (const line of dockerfile.split('\n')) {
  const m = /^\s*COPY\s+(.*)$/.exec(line);
  if (m === null) continue;
  // `COPY --from=<stage>` reads from an earlier stage, not the build context.
  if (/--from=/.test(m[1])) continue;
  const parts = m[1].split(/\s+/).filter((p) => p !== '' && !p.startsWith('--'));
  for (const source of parts.slice(0, -1)) {
    if (!existsSync(`${ROOT}${source}`)) problems.push(`${source} — not in the repository`);
    else if (excluded(source)) problems.push(`${source} — excluded by .dockerignore`);
  }
}

if (problems.length > 0) {
  console.error('Dockerfile COPY sources that will not resolve at build time:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nAdd a `!` negation to .dockerignore, or drop the COPY.');
  process.exit(1);
}
console.log('every Dockerfile COPY source is present in the build context');
