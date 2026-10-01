/**
 * The Helm chart lints, renders, and refuses what it claims to refuse.
 *
 * The chart's guards are its main feature — they move a crash-looping pod at 03:00
 * to `helm install` answering at once — and nothing exercised them: a guard that
 * stopped firing, or a template that stopped rendering, was found by whoever
 * installed the release. This renders the default values, then every guard, and
 * fails if a refusal renders or a valid configuration does not.
 *
 * Needs `helm` on the PATH (GitHub's ubuntu runners carry it).
 *
 *   node scripts/check-chart.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHART = fileURLToPath(new URL('../charts/ivanti-mcp', import.meta.url));

/** The four values without which nothing renders; each case starts from these. */
const BASE = {
  'server.publicUrl': 'https://mcp.example.com/mcp',
  'server.trustedOrigins[0]': 'https://mcp-client.example.com',
  'ivanti.baseUrl': 'https://tenant.example.com',
  'secrets.existingSecret': 'ivanti-mcp-secrets',
};

const LONG_TOKEN = 'x'.repeat(32);

/**
 * `set`: values over BASE (`null` drops a BASE value). `refuses`: the guard's message
 * must match. `has` / `lacks`: strings the rendered manifests must / must not contain.
 */
const CASES = [
  { name: 'defaults (bearer, existing secret)', has: ['kind: Deployment', 'replicas: 1', 'BEARER_TOKEN_FILE'],
    lacks: ['kind: NetworkPolicy', 'rollout-token', 'kind: Ingress', 'ENDUSER_'] },
  { name: 'no publicUrl', set: { 'server.publicUrl': null }, refuses: /server\.publicUrl is required/ },
  { name: 'publicUrl with a trailing slash', set: { 'server.publicUrl': 'https://mcp.example.com/mcp/' }, refuses: /trailing slash/ },
  { name: 'no trustedOrigins', set: { 'server.trustedOrigins[0]': null }, refuses: /trustedOrigins is required/ },
  { name: 'no ivanti.baseUrl', set: { 'ivanti.baseUrl': null }, refuses: /ivanti\.baseUrl is required/ },
  { name: 'no secret at all', set: { 'secrets.existingSecret': null }, refuses: /Set secrets\.existingSecret/ },
  { name: 'authMode not one of three', set: { 'server.authMode': 'None' }, refuses: /authMode must be none, bearer or oauth/ },
  { name: 'mode not one of two', set: { 'server.mode': 'admin' }, refuses: /mode must be full or enduser/ },

  // Sessions are in memory, and nothing routes a new session back to its pod.
  { name: 'replicaCount 2', set: { replicaCount: '2' }, refuses: /replicaCount must be 1/ },
  { name: 'replicaCount 0 (parked)', set: { replicaCount: '0' }, has: ['replicas: 0'] },
  { name: 'sessionAffinity enabled', set: { 'sessionAffinity.enabled': 'true' }, refuses: /sessionAffinity is gone/ },

  { name: 'enduser, empty allowlist', set: { 'server.mode': 'enduser' }, refuses: /needs server\.enduser\.businessObjects/ },
  { name: 'enduser with a role', set: { 'server.mode': 'enduser', 'server.enduser.businessObjects[0]': 'Incident', 'server.enduser.role': 'SelfService' },
    has: ['ENDUSER_BUSINESS_OBJECTS', 'ENDUSER_ROLE'] },
  { name: 'full with an enduser setting', set: { 'server.enduser.role': 'SelfService' }, refuses: /server\.enduser\.\* applies to mode=enduser/ },
  { name: 'impersonationRole under enduser', set: { 'server.mode': 'enduser', 'server.enduser.businessObjects[0]': 'Incident', 'ivanti.impersonationRole': 'Admin' },
    refuses: /impersonationRole applies to server\.mode=full/ },

  { name: 'oauth without an issuer', set: { 'server.authMode': 'oauth' }, refuses: /needs oauth\.issuer/ },
  { name: 'oauth over plain http', set: { 'server.authMode': 'oauth', 'oauth.issuer': 'http://sso.example.com/realms/corp' }, refuses: /oauth\.issuer must be an https/ },
  { name: 'oauth jwksUri over plain http', set: { 'server.authMode': 'oauth', 'oauth.issuer': 'https://sso.example.com', 'oauth.jwksUri': 'http://sso.example.com/certs' },
    refuses: /oauth\.jwksUri must be an https/ },
  { name: 'tenant over plain http', set: { 'ivanti.baseUrl': 'http://tenant.example.com' }, refuses: /ivanti\.baseUrl must be an https/ },
  { name: 'tenant through a loopback sidecar', set: { 'ivanti.baseUrl': 'http://127.0.0.1:8080' }, has: ['http://127.0.0.1:8080'] },
  { name: 'ConfigDB over plain http', set: { 'ivanti.configUrl': 'http://config.example.com' }, refuses: /ivanti\.configUrl must be an https/ },

  { name: 'dev secret, no API key', set: { 'secrets.existingSecret': null, 'secrets.create': 'true' }, refuses: /needs secrets\.ivantiApiKey/ },
  { name: 'dev secret, short bearer token', set: { 'secrets.existingSecret': null, 'secrets.create': 'true', 'secrets.ivantiApiKey': 'k', 'secrets.bearerToken': 'change-me' },
    refuses: /at least 32 characters/ },
  { name: 'dev secret, 32-character bearer token', set: { 'secrets.existingSecret': null, 'secrets.create': 'true', 'secrets.ivantiApiKey': 'k', 'secrets.bearerToken': LONG_TOKEN },
    has: ['kind: Secret', 'checksum/config'] },

  // authMode=none: nothing may publish it, and a NetworkPolicy fences it by default.
  { name: 'none with an ingress', set: { 'server.authMode': 'none', 'ingress.enabled': 'true' }, refuses: /none with an ingress/ },
  { name: 'none with a LoadBalancer', set: { 'server.authMode': 'none', 'service.type': 'LoadBalancer' }, refuses: /service\.type=LoadBalancer/ },
  { name: 'none with a NodePort', set: { 'server.authMode': 'none', 'service.type': 'NodePort' }, refuses: /service\.type=NodePort/ },
  { name: 'none, ClusterIP', set: { 'server.authMode': 'none' }, has: ['kind: NetworkPolicy', 'podSelector: {}', 'port: 3000'], lacks: ['BEARER_TOKEN_FILE'] },
  { name: 'none, NetworkPolicy switched off', set: { 'server.authMode': 'none', 'networkPolicy.enabled': 'false' }, lacks: ['kind: NetworkPolicy'] },
  { name: 'bearer, NetworkPolicy with peers', set: { 'networkPolicy.enabled': 'true', 'networkPolicy.from[0].namespaceSelector.matchLabels.team': 'agents' },
    has: ['kind: NetworkPolicy', 'team: agents'], lacks: ['podSelector: {}'] },
  { name: 'NetworkPolicy switch misspelt', set: { 'networkPolicy.enabled': 'maybe' }, refuses: /networkPolicy\.enabled must be auto, true or false/ },

  { name: 'rolloutToken rolls the pod', set: { rolloutToken: '2026-09-29' }, has: ['ivanti-mcp/rollout-token: "2026-09-29"'] },
  { name: 'optional server settings', set: { 'server.maxSessionsPerSubject': '5', 'ivanti.timeoutMs': '15000', 'ivanti.writeTimeoutMs': '45000',
    'ivanti.configUrl': 'https://config.example.com', 'ivanti.impersonationRequired': 'true' },
  has: ['MCP_MAX_SESSIONS_PER_SUBJECT', 'IVANTI_TIMEOUT_MS', 'IVANTI_WRITE_TIMEOUT_MS', 'IVANTI_IMPERSONATION_REQUIRED', 'IVANTI_CENTRAL_CONFIG_API_KEY_FILE'] },
];

function args(set = {}) {
  const values = { ...BASE, ...set };
  return Object.entries(values)
    .filter(([, v]) => v !== null)
    .flatMap(([k, v]) => ['--set-string', `${k}=${v}`]);
}

function helm(...argv) {
  const r = spawnSync('helm', argv, { encoding: 'utf8' });
  if (r.error) {
    console.error(`helm could not be run (${r.error.message}). Install Helm 3.8+ to check the chart.`);
    process.exit(2);
  }
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

let failed = 0;
const lint = helm('lint', '--strict', CHART, ...args());
if (!lint.ok) {
  failed += 1;
  console.error(`  FAIL  helm lint --strict\n${lint.out}`);
} else {
  console.log('  ok    helm lint --strict');
}

for (const c of CASES) {
  const r = helm('template', 'ivanti-mcp', CHART, '--namespace', 'ivanti', ...args(c.set));
  const problems = [];
  if (c.refuses) {
    if (r.ok) problems.push('rendered, but a guard should have refused it');
    else if (!c.refuses.test(r.out)) problems.push(`refused for another reason:\n${r.out.trim()}`);
  } else if (!r.ok) {
    problems.push(`did not render:\n${r.out.trim()}`);
  } else {
    for (const s of c.has ?? []) if (!r.out.includes(s)) problems.push(`missing ${JSON.stringify(s)}`);
    for (const s of c.lacks ?? []) if (r.out.includes(s)) problems.push(`unexpected ${JSON.stringify(s)}`);
  }
  if (problems.length > 0) {
    failed += 1;
    console.error(`  FAIL  ${c.name}`);
    for (const p of problems) console.error(`        ${p.split('\n').join('\n        ')}`);
  } else {
    console.log(`  ok    ${c.refuses ? 'refuses' : 'renders'}  ${c.name}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} chart check(s) failed.`);
  process.exit(1);
}
console.log(`\nThe chart lints, and all ${CASES.length} cases render or refuse as they should.`);
