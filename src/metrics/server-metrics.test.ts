// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry.js';
import { sample } from './sample.fixture.js';
import { recordIvantiRequest, recordToolCall, watchServer } from './server-metrics.js';

describe('watchServer', () => {
  it('reports what the server is and holds, read when scraped', () => {
    const registry = createRegistry();
    let ready = true;
    let sessions = 3;
    watchServer(
      {
        version: '1.2.3',
        mcpMode: 'enduser',
        ready: () => ready,
        limiter: { inFlight: 2, waiting: 1 },
        sessions: () => sessions,
      },
      registry,
    );

    ready = false;
    sessions = 4;
    const text = registry.render();

    expect(text).toContain('ivanti_mcp_build_info{version="1.2.3",mcp_mode="enduser"} 1');
    expect(text).toContain('ivanti_mcp_ivanti_ready 0');
    expect(text).toContain('ivanti_mcp_ivanti_requests_in_flight 2');
    expect(text).toContain('ivanti_mcp_ivanti_requests_waiting 1');
    expect(text).toContain('ivanti_mcp_sessions 4');
    expect(text).toMatch(/^process_resident_memory_bytes \d+$/m);
  });

  // Saying 0 sessions under stdio, or "not ready" with no tenant, would be a claim nobody made.
  it('leaves out what this deployment does not have', () => {
    const registry = createRegistry();
    watchServer({ version: '1.2.3', mcpMode: 'full' }, registry);
    const text = registry.render();

    expect(text).not.toContain('ivanti_mcp_ivanti_ready');
    expect(text).not.toContain('ivanti_mcp_sessions');
    expect(text).not.toContain('ivanti_mcp_ivanti_requests_in_flight');
  });
});

describe('the recorders', () => {
  it('counts a tool call by tool and outcome, and times it', () => {
    const before = sample('ivanti_mcp_tool_calls_total', { tool: 'probe_tool', outcome: 'RateLimited' });
    const timed = sample('ivanti_mcp_tool_call_duration_seconds_count', { tool: 'probe_tool' });

    recordToolCall('probe_tool', 'RateLimited', 1500);

    expect(sample('ivanti_mcp_tool_calls_total', { tool: 'probe_tool', outcome: 'RateLimited' })).toBe(before + 1);
    expect(sample('ivanti_mcp_tool_call_duration_seconds_count', { tool: 'probe_tool' })).toBe(timed + 1);
  });

  it('spells a method one way, whatever case it arrived in', () => {
    const before = sample('ivanti_mcp_ivanti_requests_total', { method: 'PATCH', status: '409' });

    recordIvantiRequest('patch', 409, 20);

    expect(sample('ivanti_mcp_ivanti_requests_total', { method: 'PATCH', status: '409' })).toBe(before + 1);
  });
});
