import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { configFixture } from '../config/config.fixture.js';
import { registerTools, selectTools } from './register-tools.js';

const context = { serverName: 'ivanti-mcp', serverVersion: '0.1.0' };

const config = configFixture;

describe('selectTools', () => {
  it('exposes get_version in full mode', () => {
    expect(selectTools(config(), context).map((tool) => tool.name)).toEqual(['get_version']);
  });

  it('exposes get_version in enduser mode', () => {
    const tools = selectTools(config({ MCP_MODE: 'enduser' }), context);

    expect(tools.map((tool) => tool.name)).toEqual(['get_version']);
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
