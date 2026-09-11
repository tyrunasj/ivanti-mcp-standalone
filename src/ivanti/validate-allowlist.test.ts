import { describe, expect, it } from 'vitest';
import { connectionFixture } from './connection.fixture.js';
import { validateBusinessObjectAllowlist } from './validate-allowlist.js';

const tenant = connectionFixture({ entities: { incident: {}, servicereq: {} } }).connection;

describe('validateBusinessObjectAllowlist', () => {
  it('accepts names the tenant has, in any dialect', async () => {
    await expect(
      validateBusinessObjectAllowlist(tenant, ['incident', 'servicereq']),
    ).resolves.toEqual([]);
  });

  it('reports every bad name at once, with what the tenant does have', async () => {
    const problems = await validateBusinessObjectAllowlist(tenant, ['incident', 'tickets']);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("names 'tickets'");
    expect(problems[0]).toContain('Did you mean');
  });

  it('is empty for an empty allowlist', async () => {
    await expect(validateBusinessObjectAllowlist(tenant, [])).resolves.toEqual([]);
  });
});
