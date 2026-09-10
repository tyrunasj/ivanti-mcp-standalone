import { describe, expect, it } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import { createServerFactory } from './create-server.js';

const config = configFixture();

describe('createServerFactory', () => {
  it('reports the tools every server will expose', () => {
    expect(createServerFactory(config).toolNames).toEqual(['get_version']);
  });

  it('hands out a distinct server per connection', () => {
    const factory = createServerFactory(config);

    expect(factory.create()).not.toBe(factory.create());
  });

  it('exposes the same tool set in enduser mode', () => {
    expect(createServerFactory({ ...config, MCP_MODE: 'enduser' }).toolNames).toEqual([
      'get_version',
    ]);
  });

  it('builds servers that are usable independently', () => {
    const factory = createServerFactory(config);

    expect(factory.create()).toBeDefined();
    expect(factory.create()).toBeDefined();
  });
});
