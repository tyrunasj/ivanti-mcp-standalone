// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import { IvantiApiError } from '../http/errors.js';
import { createIvantiRoutes } from '../odata/url.js';
import { createAsmxCalls } from './asmx-calls.js';

const routes = createIvantiRoutes('https://tenant.example.com', '/HEAT');
const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const SID = 'sid-secret';
const CREDENTIALS = { sid: SID, csrf: 'csrf-1' };

function calls(reply: string) {
  const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = vi.fn((url: string, init: { headers: Record<string, string>; body?: unknown }) => {
    seen.push({ url, headers: init.headers, body: init.body });
    return Promise.resolve(new Response(reply, { status: 200 }));
  });
  const asmx = createAsmxCalls(
    (sid) => ({ fetchImpl, logger, timeoutMs: 1000, secrets: sid === undefined ? [] : [sid] }),
    routes,
  );
  return { asmx, seen };
}

describe('the envelope rule', () => {
  it('unwraps { d } by default', async () => {
    const { asmx } = calls(JSON.stringify({ d: { ActiveRole: 'Admin' } }));

    await expect(asmx.callService(CREDENTIALS, 'Services/Session.asmx', 'SelectRole', {})).resolves.toEqual({
      ActiveRole: 'Admin',
    });
  });

  it('refuses an answer without the envelope, and scrubs the SID from what it keeps', async () => {
    const { asmx } = calls(JSON.stringify({ echoed: SID }));

    const failure = await asmx
      .callService(CREDENTIALS, 'Services/Session.asmx', 'SelectRole', {})
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IvantiApiError);
    expect((failure as IvantiApiError).message).toMatch(/`d` envelope/);
    expect((failure as IvantiApiError).body).not.toContain(SID);
  });

  it('refuses an empty body by default', async () => {
    const { asmx } = calls('');

    await expect(asmx.postJson('https://x/y', {}, { sid: SID })).rejects.toBeInstanceOf(IvantiApiError);
  });

  it('with envelope:false takes the bare answer and the empty one', async () => {
    const bare = calls(JSON.stringify({ roleList: [] }));
    const empty = calls('');

    await expect(bare.asmx.postJson('https://x/y', {}, { envelope: false })).resolves.toEqual({ roleList: [] });
    await expect(empty.asmx.postJson('https://x/y', {}, { envelope: false })).resolves.toEqual({});
  });

  it('reports a body that is not JSON as something Ivanti said', async () => {
    const { asmx } = calls('<html>login</html>');

    const failure = await asmx.postJson('https://x/y', {}, { envelope: false }).catch((e: unknown) => e);

    expect((failure as Error).message).toMatch(/not JSON/);
  });
});

describe('the three spellings of the CSRF token', () => {
  it('puts it in the body for an asmx service, with the cookie', async () => {
    const { asmx, seen } = calls(JSON.stringify({ d: 1 }));

    await asmx.callService(CREDENTIALS, 'Services/Workspace.asmx', 'Go', { a: 1 });

    expect(JSON.parse(String(seen[0]?.body))).toEqual({ _csrfToken: 'csrf-1', a: 1 });
    expect(seen[0]?.headers['Cookie']).toBe(`SID=${SID}`);
    expect(seen[0]?.url).toContain('Services/Workspace.asmx/Go');
  });

  it('puts it in a lowercase header for a form handler under handlers/', async () => {
    const { asmx, seen } = calls('ok');

    await asmx.postForm(CREDENTIALS, 'GridDataHandler/GridDataHandler.ashx', { q: '1' });

    expect(seen[0]?.headers['_csrftoken']).toBe('csrf-1');
    expect(seen[0]?.url).toContain('handlers/GridDataHandler/GridDataHandler.ashx');
    expect(seen[0]?.body).toBe('q=1');
  });

  it('puts it in a mixed-case header for an upload, with no Content-Type', async () => {
    const { asmx, seen } = calls('ok');

    await asmx.postMultipart(CREDENTIALS, 'handlers/Upload.ashx', new FormData());

    expect(seen[0]?.headers['_csrfToken']).toBe('csrf-1');
    expect(seen[0]?.headers['Content-Type']).toBeUndefined();
  });
});
