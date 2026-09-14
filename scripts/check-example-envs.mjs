/**
 * Every file in `examples/env/` must load.
 *
 * An example configuration that exits 78 is worse than no example: it is copied
 * before it is read. This drives the real `loadConfig`, so the shape rules and
 * the cross-field rules both apply — the same code path the server runs at boot.
 *
 * `_FILE` secrets point at paths that exist only in the target deployment, so
 * the file reader is stubbed. What is under test is the configuration, not the
 * mount.
 *
 *   node scripts/check-example-envs.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { loadConfig } from '../dist/config/load-config.js';

const dir = new URL('../examples/env/', import.meta.url);

function parse(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}

const files = readdirSync(dir).filter((n) => n.endsWith('.env')).sort();
if (files.length === 0) {
  console.error('examples/env/ has no .env files — expected at least one.');
  process.exit(2);
}

let failed = 0;
for (const name of files) {
  const env = parse(readFileSync(new URL(name, dir), 'utf8'));
  try {
    const c = loadConfig(env, (p) => `stub-secret-for:${p}`);
    const shape = [
      c.STDIO_TRANSPORT_ON ? 'stdio' : null,
      c.HTTP_TRANSPORT_ON ? `http/${env.AUTH_MODE ?? 'none'}` : null,
      c.MCP_MODE,
      c.ENDUSER_BUSINESS_OBJECTS?.length ? `gate:${c.ENDUSER_BUSINESS_OBJECTS.join('+')}` : null,
      env.IVANTI_MAX_TIER ? `tier<=${env.IVANTI_MAX_TIER}` : null,
      // The role is only ENDUSER_ROLE's business in enduser mode; full mode pins one or keeps
      // whichever non-self-service role Ivanti made active.
      c.IVANTI_CONFIG_URL
        ? `impersonates/${c.MCP_MODE === 'enduser' ? c.ENDUSER_ROLE : (c.IVANTI_IMPERSONATION_ROLE ?? 'their own role')}`
        : null,
    ].filter(Boolean).join(' · ');
    console.log(`  ok    ${name.padEnd(23)} ${shape}`);
  } catch (error) {
    failed += 1;
    const lines = String(error instanceof Error ? error.message : error).split('\n');
    console.error(`  FAIL  ${name.padEnd(22)} ${lines[0]}`);
    for (const l of lines.slice(1, 6)) console.error(`        ${l}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} example configuration(s) would exit 78.`);
  process.exit(1);
}
console.log(`\n${files.length} example configurations load.`);
