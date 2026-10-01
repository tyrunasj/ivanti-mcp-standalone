// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * Prometheus' text exposition format (0.0.4), and the three instruments this server needs.
 *
 * Small on purpose: counters, gauges read at scrape time, and histograms, rendered as text. A
 * client library for that would be the larger risk — more code shipped, another notice, another
 * thing for a scanner to flag.
 *
 * Label values are this server's own vocabulary — tool names, outcomes, HTTP methods, status
 * codes — and never anything a request carried. A person's name or a `$filter` in a label would
 * reach whoever can scrape, and would make every series unique besides.
 */
export type Labels = Readonly<Record<string, string>>;

export interface Counter {
  inc: (labels?: Labels, by?: number) => void;
  /** The current value, for a test. */
  value: (labels?: Labels) => number;
}

export interface Histogram {
  observe: (value: number, labels?: Labels) => void;
  /** How many observations, for a test. */
  count: (labels?: Labels) => number;
}

/** A gauge is read when scraped. `undefined` leaves it out: nothing is known, so nothing is said. */
export type GaugeReading = number | undefined | readonly (readonly [Labels, number])[];

export interface Registry {
  counter: (name: string, help: string, labelNames?: readonly string[]) => Counter;
  histogram: (
    name: string,
    help: string,
    buckets: readonly number[],
    labelNames?: readonly string[],
  ) => Histogram;
  /** Registering a name again replaces its reader: what the latest startup wired is what counts. */
  gauge: (name: string, help: string, read: () => GaugeReading) => void;
  render: () => string;
}

interface Family {
  render: () => string[];
}

export function createRegistry(): Registry {
  const families = new Map<string, Family>();

  const define = (name: string, family: Family): void => {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`Invalid metric name: ${name}`);
    families.set(name, family);
  };

  return {
    counter(name, help, labelNames = []): Counter {
      const values = new Map<string, number>();
      define(name, {
        render: () => [
          ...header(name, help, 'counter'),
          // A counter without labels says 0 before anything happens, so a rate has a start.
          ...(labelNames.length === 0 && values.size === 0 ? [`${name} 0`] : []),
          ...[...values].map(([key, value]) => `${name}${key} ${formatNumber(value)}`),
        ],
      });
      return {
        inc(labels = {}, by = 1): void {
          const key = labelKey(labelNames, labels);
          values.set(key, (values.get(key) ?? 0) + by);
        },
        value: (labels = {}) => values.get(labelKey(labelNames, labels)) ?? 0,
      };
    },

    histogram(name, help, buckets, labelNames = []): Histogram {
      const sorted = [...buckets].sort((a, b) => a - b);
      const series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
      define(name, {
        render: () => [
          ...header(name, help, 'histogram'),
          ...[...series.values()].flatMap(({ labels, counts, sum, count }) => [
            ...sorted.map(
              (bound, i) =>
                `${name}_bucket${labelKey([...labelNames, 'le'], { ...labels, le: formatNumber(bound) })} ` +
                String(counts[i] ?? 0),
            ),
            `${name}_bucket${labelKey([...labelNames, 'le'], { ...labels, le: '+Inf' })} ${String(count)}`,
            `${name}_sum${labelKey(labelNames, labels)} ${formatNumber(sum)}`,
            `${name}_count${labelKey(labelNames, labels)} ${String(count)}`,
          ]),
        ],
      });
      return {
        observe(value, labels = {}): void {
          const key = labelKey(labelNames, labels);
          let entry = series.get(key);
          if (entry === undefined) {
            entry = { labels, counts: sorted.map(() => 0), sum: 0, count: 0 };
            series.set(key, entry);
          }
          // Cumulative, as the format has it: an observation counts in every bucket it fits.
          sorted.forEach((bound, i) => {
            if (value <= bound && entry !== undefined) entry.counts[i] = (entry.counts[i] ?? 0) + 1;
          });
          entry.sum += value;
          entry.count += 1;
        },
        count: (labels = {}) => series.get(labelKey(labelNames, labels))?.count ?? 0,
      };
    },

    gauge(name, help, read): void {
      define(name, {
        render: () => {
          let reading: GaugeReading;
          try {
            reading = read();
          } catch {
            // One reader failing must not cost the scrape every other metric.
            reading = undefined;
          }
          if (reading === undefined) return [];
          const samples: readonly (readonly [Labels, number])[] =
            typeof reading === 'number' ? [[{}, reading]] : reading;
          return [
            ...header(name, help, 'gauge'),
            ...samples.map(
              ([labels, value]) => `${name}${labelKey(Object.keys(labels), labels)} ${formatNumber(value)}`,
            ),
          ];
        },
      });
    },

    render: () => `${[...families.values()].flatMap((family) => family.render()).join('\n')}\n`,
  };
}

function header(name: string, help: string, type: string): string[] {
  return [`# HELP ${name} ${help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`, `# TYPE ${name} ${type}`];
}

/** In the declared order, so one label set always has one spelling. */
function labelKey(names: readonly string[], labels: Labels): string {
  if (names.length === 0) return '';
  const pairs = names.map((name) => `${name}="${escapeLabelValue(labels[name] ?? '')}"`);
  return `{${pairs.join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}
