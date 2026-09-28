/**
 * Regenerates the manifest snapshot the handbook embeds — `const DATA` in docs/handbook.html — from
 * the code, as a client sees it over the protocol.
 *
 * The handbook promises "every tool with its real description". It carried a hand-pasted snapshot,
 * and by 0.2.3 that snapshot told readers `act_as` was optional — the opposite of what the server had
 * done for weeks. Nothing regenerated it, so nothing noticed.
 *
 *   node --import tsx scripts/handbook-data.mjs --write   (pnpm handbook:sync)
 *   node --import tsx scripts/handbook-data.mjs --check   (pnpm handbook:check, in CI)
 *
 * It describes the default deployment: `full` mode, a credential that reaches the admin console, no
 * impersonation. `enduser` marks the tools that mode also registers. The account the instructions
 * name is a placeholder — the snapshot once carried a real person's name. The version is left out:
 * the page takes it from `const VERSION`, which `pnpm version:sync` owns.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configFixture } from '../src/config/config.fixture.js';
import { connectionFixture } from '../src/ivanti/connection.fixture.js';
import { selectTools } from '../src/tools/register-tools.js';
import { registerResources, selectResources } from '../src/resources/register-resources.js';
import { buildInstructions } from '../src/server/instructions.js';

const HANDBOOK = new URL('../docs/handbook.html', import.meta.url);
const DATA_LINE = /^const DATA = (.*);$/m;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

const context = () => ({
  serverName: pkg.name,
  serverVersion: pkg.version,
  logger: silent,
  ivanti: connectionFixture({
    entities: { incident: {}, change: {}, servicereq: {}, employee: {}, journal__notes: {} },
    capability: {
      tier: 'admin',
      identity: { role: 'Admin', displayName: 'MCP Service Account' },
      canImpersonate: false,
    },
  }).connection,
});

const FULL = configFixture({ MCP_MODE: 'full' });
const ENDUSER = configFixture({
  MCP_MODE: 'enduser',
  ENDUSER_BUSINESS_OBJECTS: ['incident'],
  ENDUSER_QUICK_ACTIONS: ['Close From Self Service'],
});

/** What a client is told, read back over an in-memory connection rather than reconstructed. */
async function listed(config) {
  const ctx = context();
  const server = new McpServer({ name: pkg.name, version: pkg.version });
  const tools = selectTools(config, ctx);
  for (const tool of tools) server.registerTool(tool.name, tool.config, tool.handler);
  const resources = selectResources(config, ctx);
  registerResources(server, resources);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'handbook-data', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const result = {
    tools: (await client.listTools()).tools,
    resources: (await client.listResources()).resources,
    instructions:
      buildInstructions({
        capability: ctx.ivanti.capability,
        mode: config.MCP_MODE,
        resourceUris: resources.map((r) => r.uri),
      }) ?? '',
  };
  await client.close();
  return result;
}

const typeOf = (p) =>
  Array.isArray(p.type) ? p.type.join(' | ')
    : p.type ?? (Array.isArray(p.anyOf) ? p.anyOf.map(typeOf).join(' | ') : 'object');

const html = readFileSync(HANDBOOK, 'utf8');
const match = html.match(DATA_LINE);
if (match === null) {
  console.error('docs/handbook.html has no `const DATA = …;` line.');
  process.exit(2);
}
const previous = JSON.parse(match[1]);
// Grouping is editorial — the handbook's, not the code's — so it is carried over, and a tool the
// handbook has never seen is refused until someone decides where it belongs.
const groupOf = new Map(previous.tools.map((t) => [t.name, t.group]));
const orderOf = new Map(previous.tools.map((t, i) => [t.name, i]));

const full = await listed(FULL);
const enduser = await listed(ENDUSER);
const enduserNames = new Set(enduser.tools.map((t) => t.name));

const ungrouped = full.tools.map((t) => t.name).filter((name) => !groupOf.has(name));
if (ungrouped.length > 0) {
  console.error(`No handbook group for: ${ungrouped.join(', ')}. Add them to DATA by hand once.`);
  process.exit(2);
}

const data = {
  tools: full.tools
    .map((t) => {
      const a = t.annotations ?? {};
      const required = new Set(t.inputSchema?.required ?? []);
      return {
        name: t.name,
        group: groupOf.get(t.name),
        title: t.title ?? a.title ?? t.name,
        desc: t.description ?? '',
        risk: a.readOnlyHint ? 'read' : a.destructiveHint === false ? 'write' : 'destructive',
        idem: a.idempotentHint === true,
        enduser: enduserNames.has(t.name),
        args: Object.entries(t.inputSchema?.properties ?? {}).map(([name, p]) => ({
          name,
          type: typeOf(p),
          required: required.has(name),
          desc: p.description ?? '',
        })),
      };
    })
    .sort((x, y) => (orderOf.get(x.name) ?? 1e9) - (orderOf.get(y.name) ?? 1e9)),
  resources: full.resources.map(({ uri, name, title, description, mimeType }) => ({
    uri, name, title, description, mimeType,
  })),
  instructions: full.instructions,
  instructionsEnduser: enduser.instructions,
  server: { name: pkg.name },
};

const next = html.replace(DATA_LINE, () => `const DATA = ${JSON.stringify(data)};`);
const mode = process.argv[2];

if (mode === '--write') {
  writeFileSync(HANDBOOK, next);
  console.log(`handbook data: ${data.tools.length} tools (${enduserNames.size} in enduser), ${data.resources.length} resources`);
} else if (mode === '--check') {
  if (next !== html) {
    console.error('docs/handbook.html describes a different tool surface from the code. Run `pnpm handbook:sync`.');
    process.exit(1);
  }
  console.log('handbook data matches the code');
} else {
  console.error('usage: node --import tsx scripts/handbook-data.mjs --write | --check');
  process.exit(2);
}
process.exit(0);
