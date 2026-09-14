/**
 * Keeps the version in one place, and refuses a release when it is not.
 *
 * Three files claim a version and they must agree:
 *
 *   package.json           `src/version.ts` reads the manifest at startup and the server refuses
 *                          to boot without it, so the version IN the image is whatever this says
 *                          — not what the git tag says.
 *   Chart.yaml `version`   the chart artifact's own version.
 *   Chart.yaml `appVersion` the default image tag: `values.yaml` leaves `image.tag` empty and the
 *                          deployment falls back to appVersion, so drift here silently deploys
 *                          the wrong image.
 *
 * Let any of them drift and you publish `ivanti-mcp:1.2.3` whose /health reports something else,
 * or a chart that installs a different image than it claims. Nobody notices until an incident.
 *
 *   node scripts/check-version.mjs v1.2.3   # release guard: tag must match all three
 *   node scripts/check-version.mjs --check  # CI guard: the three must match each other
 *   node scripts/check-version.mjs --sync   # write package.json's version into Chart.yaml
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PKG = new URL('../package.json', import.meta.url);
const CHART = new URL('../charts/ivanti-mcp/Chart.yaml', import.meta.url);

const pkgVersion = JSON.parse(readFileSync(PKG, 'utf8')).version;
const chart = readFileSync(CHART, 'utf8');

const read = (key) => {
  const m = chart.match(new RegExp(`^${key}:\\s*"?([^"\\s]+)"?\\s*$`, 'm'));
  if (m === null) {
    console.error(`Chart.yaml has no top-level \`${key}\`.`);
    process.exit(2);
  }
  return m[1];
};

const arg = (process.argv[2] ?? '').trim();

if (arg === '--sync') {
  const next = chart
    .replace(/^version:\s*.*$/m, `version: ${pkgVersion}`)
    .replace(/^appVersion:\s*.*$/m, `appVersion: "${pkgVersion}"`);
  writeFileSync(CHART, next);
  console.log(`Chart.yaml synced to ${pkgVersion}`);
  process.exit(0);
}

if (arg === '') {
  console.error('usage: node scripts/check-version.mjs <git tag> | --check | --sync');
  process.exit(2);
}

const chartVersion = read('version');
const chartApp = read('appVersion');
// `--check` has no tag to compare against, so package.json is the reference.
const wanted = arg === '--check' ? pkgVersion : arg.replace(/^v/, '');

const mismatched = [
  ['package.json', pkgVersion],
  ['Chart.yaml version', chartVersion],
  ['Chart.yaml appVersion', chartApp],
].filter(([, value]) => value !== wanted);

if (mismatched.length > 0) {
  const source = arg === '--check' ? 'package.json' : `tag ${arg}`;
  console.error(
    `Version drift against ${source} (${wanted}):\n` +
      mismatched.map(([where, value]) => `  ${where.padEnd(22)} ${value}`).join('\n') +
      '\n\nThe server reports its version from package.json and the chart deploys appVersion by ' +
      'default, so publishing this would ship artifacts that misreport what they are.\n' +
      'Run `pnpm version:sync` after bumping package.json, or retag.',
  );
  process.exit(1);
}

console.log(`version ok: ${wanted} (package.json, Chart.yaml version, Chart.yaml appVersion)`);
