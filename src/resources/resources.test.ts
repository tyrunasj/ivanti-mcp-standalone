import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Capability } from '../ivanti/session/capability.js';
import type { Logger } from '../logger.js';
import { selectTools, type ToolContext } from '../tools/register-tools.js';
import { selectResources } from './register-resources.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const GATED = { MCP_MODE: 'enduser' as const, ENDUSER_BUSINESS_OBJECTS: ['incident'] };

function deployment(mode: 'full' | 'enduser', tier: Capability['tier']) {
  const config = configFixture(mode === 'enduser' ? GATED : { MCP_MODE: 'full' });
  const context: ToolContext = {
    serverName: 'ivanti-mcp',
    serverVersion: '0.1.0',
    logger: logger(),
    ivanti: connectionFixture({
      entities: { incident: {}, employee: {} },
      capability: tier === 'odata' ? { tier: 'odata', reason: 'fixture' } : { tier },
    }).connection,
  };

  return {
    tools: selectTools(config, context).map((tool) => tool.name),
    resources: selectResources(config, context),
  };
}

const DEPLOYMENTS = [
  ['full', 'admin'],
  ['full', 'session'],
  ['full', 'odata'],
  ['enduser', 'admin'],
  ['enduser', 'session'],
  ['enduser', 'odata'],
] as const;

/** Every tool this server has in any configuration — the vocabulary the guard matches against. */
const EVERY_TOOL_NAME = new Set(DEPLOYMENTS.flatMap(([mode, tier]) => deployment(mode, tier).tools));

describe('the reference documents', () => {
  it('are absent without a tenant, because there is nothing to refer to', () => {
    const resources = selectResources(configFixture(), {
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
      logger: logger(),
    });

    expect(resources).toEqual([]);
  });

  it.each(DEPLOYMENTS)('never name a tool %s/%s does not register', (mode, tier) => {
    // The failure this prevents: a document telling the model to call something that is not
    // there. A model cannot tell "not registered here" from "you used it wrong", so it retries.
    const { tools, resources } = deployment(mode, tier);
    const registered = new Set(tools);

    for (const resource of resources) {
      for (const name of EVERY_TOOL_NAME) {
        if (!new RegExp(`\\b${name}\\b`).test(resource.text)) continue;

        expect(
          registered.has(name),
          `${resource.uri} names ${name}, which ${mode}/${tier} does not register`,
        ).toBe(true);
      }
    }
  });

  it('does not promise tools that are not built yet', () => {
    // B6 landed, so most of this list went with it. What remains is the staged-upload pair,
    // which needs an upload page this server does not host — see docs/initial-design.md.
    const notBuilt = ['request_attachment_upload', 'check_attachment_upload'];

    for (const [mode, tier] of DEPLOYMENTS) {
      for (const resource of deployment(mode, tier).resources) {
        for (const name of notBuilt) {
          expect(resource.text, `${resource.uri} promises ${name}`).not.toContain(name);
        }
      }
    }
  });

  it('narrows the way the tools do', () => {
    const uris = (mode: 'full' | 'enduser', tier: Capability['tier']): string[] =>
      deployment(mode, tier).resources.map((resource) => resource.uri);

    // Picklist values live on a create form, which OData cannot reach.
    expect(uris('full', 'odata')).not.toContain('ivanti://reference/picklists');
    expect(uris('full', 'session')).toContain('ivanti://reference/picklists');

    // Quick actions, approvals and the relationship tools are staff surfaces.
    expect(uris('enduser', 'session')).not.toContain('ivanti://reference/workflow');
    expect(uris('full', 'session')).toContain('ivanti://reference/workflow');
  });

  it('are well formed, so a client can list them', () => {
    for (const [mode, tier] of DEPLOYMENTS) {
      for (const resource of deployment(mode, tier).resources) {
        expect(resource.uri).toBe(`ivanti://reference/${resource.name}`);
        expect(resource.title.length).toBeGreaterThan(0);
        expect(resource.description.length).toBeGreaterThan(0);
        // Long enough to be worth a round trip, short enough not to be a book.
        expect(resource.text.length).toBeGreaterThan(500);
        expect(resource.text.length).toBeLessThan(8000);
        expect(resource.text.startsWith('# ')).toBe(true);
      }
    }
  });
});
