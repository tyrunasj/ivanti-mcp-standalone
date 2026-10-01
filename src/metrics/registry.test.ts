// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry.js';

describe('createRegistry', () => {
  it('renders a counter in the text format, with its help and type', () => {
    const registry = createRegistry();
    const calls = registry.counter('calls_total', 'Calls made.', ['tool']);

    calls.inc({ tool: 'list_records' });
    calls.inc({ tool: 'list_records' }, 2);

    expect(registry.render()).toBe(
      '# HELP calls_total Calls made.\n# TYPE calls_total counter\ncalls_total{tool="list_records"} 3\n',
    );
  });

  it('says 0 for a counter without labels before anything happens, so a rate has a start', () => {
    const registry = createRegistry();
    registry.counter('refused_total', 'Refused.');

    expect(registry.render()).toContain('\nrefused_total 0\n');
  });

  it('escapes a label value, so nothing in one can end the line or the quotes', () => {
    const registry = createRegistry();
    registry.counter('x_total', 'X.', ['outcome']).inc({ outcome: 'a"b\\c\nd' });

    expect(registry.render()).toContain('x_total{outcome="a\\"b\\\\c\\nd"} 1');
  });

  it('keeps one spelling per label set, whatever order the labels arrive in', () => {
    const registry = createRegistry();
    const counter = registry.counter('y_total', 'Y.', ['method', 'status']);

    counter.inc({ status: '200', method: 'GET' });
    counter.inc({ method: 'GET', status: '200' });

    expect(counter.value({ method: 'GET', status: '200' })).toBe(2);
  });

  it('renders a histogram with cumulative buckets, +Inf, a sum and a count', () => {
    const registry = createRegistry();
    const duration = registry.histogram('d_seconds', 'D.', [1, 0.1], ['tool']);

    duration.observe(0.05, { tool: 't' });
    duration.observe(0.5, { tool: 't' });
    duration.observe(5, { tool: 't' });

    expect(registry.render()).toBe(
      [
        '# HELP d_seconds D.',
        '# TYPE d_seconds histogram',
        'd_seconds_bucket{tool="t",le="0.1"} 1',
        'd_seconds_bucket{tool="t",le="1"} 2',
        'd_seconds_bucket{tool="t",le="+Inf"} 3',
        'd_seconds_sum{tool="t"} 5.55',
        'd_seconds_count{tool="t"} 3',
        '',
      ].join('\n'),
    );
  });

  it('reads a gauge when scraped, and leaves out one with nothing to say', () => {
    const registry = createRegistry();
    let held = 2;
    registry.gauge('held', 'Held.', () => held);
    registry.gauge('unknown', 'Not known here.', () => undefined);

    held = 5;

    expect(registry.render()).toBe('# HELP held Held.\n# TYPE held gauge\nheld 5\n');
  });

  it('does not let one failing gauge cost the scrape the rest', () => {
    const registry = createRegistry();
    registry.gauge('broken', 'Broken.', () => {
      throw new Error('nope');
    });
    registry.counter('fine_total', 'Fine.');

    expect(registry.render()).toContain('fine_total 0');
    expect(registry.render()).not.toContain('broken');
  });

  it('replaces a gauge registered again, rather than reporting it twice', () => {
    const registry = createRegistry();
    registry.gauge('g', 'G.', () => 1);
    registry.gauge('g', 'G.', () => 2);

    expect(registry.render().match(/^g /gm)).toEqual(['g ']);
    expect(registry.render()).toContain('g 2');
  });

  it('refuses a name the format would not accept', () => {
    expect(() => createRegistry().counter('bad-name', 'Bad.')).toThrow(/Invalid metric name/);
  });
});
