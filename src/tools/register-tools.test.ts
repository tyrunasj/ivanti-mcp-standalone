import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { registerTools, selectTools } from './register-tools.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const context = { serverName: 'ivanti-mcp', serverVersion: '0.1.0', logger: logger() };

const config = configFixture;

describe('selectTools', () => {
  it('exposes only get_version when no tenant is configured', () => {
    // Without a connection the Ivanti tools do not exist at all, rather than existing and
    // failing: an unregistered tool never appears in tools/list.
    expect(selectTools(config(), context).map((tool) => tool.name)).toEqual(['get_version']);
    expect(selectTools(config({ MCP_MODE: 'enduser' }), context).map((t) => t.name)).toEqual([
      'get_version',
    ]);
  });

  it('adds the schema tools once a tenant is configured', () => {
    const { connection } = connectionFixture();

    const names = selectTools(config(), { ...context, ivanti: connection }).map((t) => t.name);

    expect(names).toContain('list_business_objects');
    expect(names).toContain('get_object_metadata');
  });

  it('gives an end user the same read-only schema tools', () => {
    const { connection } = connectionFixture();

    const names = selectTools(config({ MCP_MODE: 'enduser', ENDUSER_BUSINESS_OBJECTS: ['Incident'] }), {
      ...context,
      ivanti: connection,
    }).map((t) => t.name);

    expect(names).toContain('get_object_metadata');
  });
});

describe('registerTools', () => {
  it('registers each supplied tool on the server', () => {
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;

    const names = registerTools(server, selectTools(config(), context));

    expect(names).toEqual(['get_version']);
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool).toHaveBeenCalledWith(
      'get_version',
      expect.objectContaining({ title: 'Get server version' }),
      expect.any(Function),
    );
  });

  it('shares one definition object across servers rather than rebuilding it', () => {
    // This is the point of hoisting the registry: `registerTool` stores the config by
    // reference, so a shared definition means one copy of the schemas for every session.
    const tools = selectTools(config(), context);
    const a = vi.fn();
    const b = vi.fn();

    registerTools({ registerTool: a } as unknown as McpServer, tools);
    registerTools({ registerTool: b } as unknown as McpServer, tools);

    expect(a.mock.calls[0]?.[1]).toBe(b.mock.calls[0]?.[1]);
    expect(a.mock.calls[0]?.[2]).toBe(b.mock.calls[0]?.[2]);
  });
});
