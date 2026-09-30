// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { checkTenant } from './check-tenant.js';
import type { IvantiTransport } from './http/transport.js';
import { IvantiApiError } from './http/errors.js';

const CSDL =
  '<?xml version="1.0"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">' +
  '<edmx:DataServices><Schema Namespace="x" xmlns="http://docs.oasis-open.org/odata/ns/edm"/></edmx:DataServices></edmx:Edmx>';

const connection = (answer: () => Promise<string>) => {
  const requestText = vi.fn(answer);
  return {
    requestText,
    metadataUrl: 'https://t/HEAT/api/odata/incidents/$metadata',
    transport: { requestText } as unknown as IvantiTransport,
  };
};

describe('checkTenant', () => {
  it('passes when the tenant still serves its schema, at the URL startup settled on', async () => {
    const c = connection(() => Promise.resolve(CSDL));

    await expect(checkTenant(c)).resolves.toBeUndefined();
    expect(c.requestText).toHaveBeenCalledWith('https://t/HEAT/api/odata/incidents/$metadata');
  });

  // A 200 from a proxy's login page, or a tenant in maintenance, cannot serve a tool call.
  it('fails on a 200 that is not the schema', async () => {
    const c = connection(() => Promise.resolve('<html><title>Sign in</title></html>'));

    await expect(checkTenant(c)).rejects.toThrow(/not with its schema/);
  });

  it('fails with Ivanti\'s own refusal when it refuses', async () => {
    const refused = new IvantiApiError({ status: 401, method: 'GET', url: 'https://t/x' });
    const c = connection(() => Promise.reject(refused));

    await expect(checkTenant(c)).rejects.toBe(refused);
  });
});
