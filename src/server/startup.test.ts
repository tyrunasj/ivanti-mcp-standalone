// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../config/load-config.js';
import { TenantRefusedError } from '../ivanti/http/base-path.js';
import { ListenError } from './start-http.js';
import { classifyStartupFailure, closeStarted } from './startup.js';

describe('classifyStartupFailure', () => {
  it('treats a configuration error as a configuration exit', () => {
    expect(classifyStartupFailure(new ConfigError(['x']))).toMatchObject({ kind: 'config' });
  });

  // A wrong key under `RestartPreventExitStatus=78` must stop the unit, not hammer the tenant.
  it('treats a key the tenant refused as a configuration exit, naming the setting', () => {
    const failure = classifyStartupFailure(
      new TenantRefusedError('Ivanti refused the API key: 401 … check IVANTI_API_KEY'),
    );

    expect(failure).toMatchObject({ kind: 'config' });
    expect(failure.kind === 'config' && failure.message).toContain('IVANTI_API_KEY');
  });

  it('leaves an unreachable tenant, and anything unknown, as a crash', () => {
    expect(classifyStartupFailure(new Error('Could not reach Ivanti OData'))).toEqual({ kind: 'crash' });
    expect(classifyStartupFailure('boom')).toEqual({ kind: 'crash' });
  });

  it('leaves a bind failure to the log it already wrote', () => {
    expect(classifyStartupFailure(new ListenError('in use', 'EADDRINUSE'))).toEqual({ kind: 'logged' });
  });
});

describe('closeStarted', () => {
  it('closes every part that was started, skipping the ones that were not', async () => {
    const stdio = { close: vi.fn(() => Promise.resolve()) };
    const http = { close: vi.fn(() => Promise.resolve()) };

    await closeStarted([stdio, undefined, http], { warn: vi.fn() });

    expect(stdio.close).toHaveBeenCalledOnce();
    expect(http.close).toHaveBeenCalledOnce();
  });

  it('closes the rest, and says so, when one will not close', async () => {
    const warn = vi.fn();
    const later = { close: vi.fn(() => Promise.resolve()) };

    await closeStarted([{ close: () => Promise.reject(new Error('stuck')) }, later], { warn });

    expect(later.close).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });
});
