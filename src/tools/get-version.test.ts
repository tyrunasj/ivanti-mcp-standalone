import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { buildVersionInfo, createGetVersionTool } from './get-version.js';

const deps = { serverName: 'ivanti-mcp', serverVersion: '0.1.0' };

describe('buildVersionInfo', () => {
  it('reports the injected server identity', () => {
    expect(buildVersionInfo(deps)).toMatchObject({
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
    });
  });

  it("defaults to the SDK's protocol version", () => {
    expect(buildVersionInfo(deps).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('reports the installed SDK version', () => {
    expect(buildVersionInfo(deps).sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('allows the protocol version to be overridden', () => {
    expect(buildVersionInfo({ ...deps, protocolVersion: '2025-06-18' }).protocolVersion).toBe(
      '2025-06-18',
    );
  });
});

describe('createGetVersionTool', () => {
  it('is annotated as a read-only, closed-world tool', () => {
    const { config } = createGetVersionTool(deps);

    expect(config.annotations.readOnlyHint).toBe(true);
    expect(config.annotations.idempotentHint).toBe(true);
    expect(config.annotations.openWorldHint).toBe(false);
  });

  it('returns the version info as JSON text content', () => {
    const result = createGetVersionTool(deps).handler();
    const [block] = result.content;

    expect(block?.type).toBe('text');
    expect(JSON.parse(block?.type === 'text' ? block.text : '')).toMatchObject({
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
      protocolVersion: LATEST_PROTOCOL_VERSION,
    });
  });
});
