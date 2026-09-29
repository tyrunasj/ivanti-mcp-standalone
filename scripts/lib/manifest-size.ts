// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * What the manifest, the instructions and the reference documents cost a conversation.
 *
 * In CHARACTERS by default, because this server serves any model and every vendor tokenizes
 * differently: a count exact for one family is wrong for the next, while characters are what this
 * server actually controls, need no network and come out the same every time — which is what lets
 * CI compare a pull request with its base. Relative questions (which tool is dearest, what an edit
 * moved) have the same answer in any unit. One caveat: JSON schemas and hex ids pack fewer
 * characters into a token than prose, so across very different kinds of text the ranking is a
 * little kinder to schemas than a tokenizer would be.
 *
 * The `Counter` is pluggable so a deployment known to serve one model family can price in that
 * vendor's tokens. That is why every figure is a DIFFERENCE between two counts: a vendor's counter
 * prices a whole request, and a request carrying any tool pays a fixed tool-use preamble that is
 * not this server's doing — so every count carries one empty probe tool, and the probe alone is
 * subtracted. With the character counter the subtraction is nearly a no-op.
 */

export interface ApiTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface CountRequest {
  system?: string;
  tools: readonly ApiTool[];
  /** A user turn: where resource text is priced. */
  text?: string;
}

export interface Counter {
  /** The unit, as reports print it — and what two snapshots must share to be compared. */
  unit: string;
  count: (request: CountRequest) => Promise<number>;
}

/**
 * The tools as JSON, the instructions and the text, in characters.
 *
 * The tool shape is the one a client hands a model — name, description, argument schema — not the
 * whole `tools/list` entry: `title` and `annotations` steer the client, not the model.
 */
export const CHARACTERS: Counter = {
  unit: 'characters',
  count: (request) =>
    Promise.resolve(
      (request.system?.length ?? 0) +
        (request.tools.length === 0 ? 0 : JSON.stringify(request.tools).length) +
        (request.text?.length ?? 0),
    ),
};

/** A tool as `tools/list` returns it. */
export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface Deployment {
  label: string;
  tools: readonly ListedTool[];
  instructions: string;
}

export interface DeploymentCost {
  label: string;
  tools: number;
  manifest: number;
  instructions: number;
}

export interface ToolCost {
  name: string;
  total: number;
  /** The rest — name, argument schema and the argument descriptions inside it — is `total - description`. */
  description: number;
}

export interface Snapshot {
  unit: string;
  deployments: DeploymentCost[];
  /** The deployment the per-tool figures were taken from: the dearest. */
  widest: string;
  tools: ToolCost[];
  resources: { uri: string; cost: number }[];
}

export const PROBE_TOOL: ApiTool = {
  name: 'probe',
  input_schema: { type: 'object', properties: {} },
};

export function toApiTool(tool: ListedTool): ApiTool {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    input_schema: tool.inputSchema,
  };
}

/** Runs `run` over `items`, `limit` at a time — quick, and gentle on a vendor's rate limit. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function measure(
  counter: Counter,
  deployments: readonly Deployment[],
  resources: readonly { uri: string; text: string }[],
): Promise<Snapshot> {
  const base = await counter.count({ tools: [PROBE_TOOL] });
  const marginal = async (request: Partial<CountRequest>): Promise<number> =>
    (await counter.count({ ...request, tools: [PROBE_TOOL, ...(request.tools ?? [])] })) - base;

  const costs = await mapLimit(deployments, 4, async (deployment): Promise<DeploymentCost> => ({
    label: deployment.label,
    tools: deployment.tools.length,
    manifest: await marginal({ tools: deployment.tools.map(toApiTool) }),
    instructions:
      deployment.instructions === '' ? 0 : await marginal({ system: deployment.instructions }),
  }));

  const widest = costs.reduce((a, b) => (b.manifest > a.manifest ? b : a));
  const widestTools = deployments.find((deployment) => deployment.label === widest.label)?.tools ?? [];

  const tools = await mapLimit(widestTools, 4, async (tool): Promise<ToolCost> => {
    const api = toApiTool(tool);
    const total = await marginal({ tools: [api] });
    const bare = await marginal({ tools: [{ name: api.name, input_schema: api.input_schema }] });
    return { name: tool.name, total, description: total - bare };
  });

  const resourceCosts = await mapLimit(resources, 4, async (resource) => ({
    uri: resource.uri,
    cost: await marginal({ text: resource.text }),
  }));

  return {
    unit: counter.unit,
    deployments: costs,
    widest: widest.label,
    tools: [...tools].sort((a, b) => b.total - a.total),
    resources: resourceCosts.sort((a, b) => b.cost - a.cost),
  };
}

const n = (value: number): string => value.toLocaleString('en-US');
const signed = (value: number): string => `${value > 0 ? '+' : ''}${n(value)}`;
const perRequest = (d: DeploymentCost): number => d.manifest + d.instructions;

interface Moved {
  label: string;
  before?: number;
  after?: number;
}

/** Every figure that moved between two snapshots, by section. */
function moved(
  before: Snapshot,
  after: Snapshot,
): { deployments: Moved[]; tools: Moved[]; resources: Moved[] } {
  const diff = <T>(
    was: readonly T[],
    now: readonly T[],
    key: (item: T) => string,
    value: (item: T) => number,
  ): Moved[] => {
    const a = new Map(was.map((item) => [key(item), value(item)]));
    const b = new Map(now.map((item) => [key(item), value(item)]));
    return [...new Set([...a.keys(), ...b.keys()])]
      .map((label) => ({ label, before: a.get(label), after: b.get(label) }))
      .filter((row) => row.before !== row.after);
  };
  return {
    deployments: diff(before.deployments, after.deployments, (d) => d.label, perRequest),
    tools: diff(before.tools, after.tools, (t) => t.name, (t) => t.total),
    resources: diff(before.resources, after.resources, (r) => r.uri, (r) => r.cost),
  };
}

const change = (row: Moved): number => (row.after ?? 0) - (row.before ?? 0);
const state = (row: Moved): string =>
  row.before === undefined ? ' (new)' : row.after === undefined ? ' (gone)' : '';

/** What changed between two snapshots, one line per figure that moved. */
export function compare(before: Snapshot, after: Snapshot): string[] {
  if (before.unit !== after.unit) {
    return [`Not comparable: ${before.unit} against ${after.unit}.`];
  }
  const { deployments, tools, resources } = moved(before, after);
  const line =
    (prefix: string) =>
    (row: Moved): string =>
      `${prefix}${row.label}: ${n(row.before ?? 0)} → ${n(row.after ?? 0)} ` +
      `(${signed(change(row))})${state(row)}`;
  return [
    ...deployments.map(line('per request, ')),
    ...tools.map(line('tool ')),
    ...resources.map(line('')),
  ];
}

/** One line for a CI annotation: what the dearest deployment now costs every request. */
export function headline(before: Snapshot, after: Snapshot): string {
  const was = before.deployments.find((d) => d.label === after.widest);
  const now = after.deployments.find((d) => d.label === after.widest);
  if (was === undefined || now === undefined) return `Measured ${after.widest}; nothing to compare it with.`;
  const delta = perRequest(now) - perRequest(was);
  return delta === 0
    ? `Manifest + instructions unchanged: ${n(perRequest(now))} ${after.unit} per request (${after.widest}).`
    : `Manifest + instructions: ${n(perRequest(was))} → ${n(perRequest(now))} ${after.unit} per request ` +
        `(${signed(delta)}, ${after.widest}).`;
}

/** The pull request's job summary: every deployment, and what moved beneath it. */
export function markdown(after: Snapshot, before?: Snapshot): string {
  const lines = [`### Manifest size — ${after.unit} sent with every request`, ''];

  if (before === undefined) {
    lines.push('| deployment | tools | manifest | instructions | per request |', '|---|--:|--:|--:|--:|');
    for (const d of after.deployments) {
      lines.push(`| ${d.label} | ${String(d.tools)} | ${n(d.manifest)} | ${n(d.instructions)} | ${n(perRequest(d))} |`);
    }
    return lines.join('\n');
  }

  if (before.unit !== after.unit) return [...lines, compare(before, after)[0] ?? ''].join('\n');

  const was = new Map(before.deployments.map((d) => [d.label, d]));
  lines.push('| deployment | base | this PR | change |', '|---|--:|--:|--:|');
  for (const d of after.deployments) {
    const base = was.get(d.label);
    const delta = base === undefined ? undefined : perRequest(d) - perRequest(base);
    lines.push(
      `| ${d.label} | ${base === undefined ? '—' : n(perRequest(base))} | ${n(perRequest(d))} | ` +
        `${delta === undefined ? 'new' : delta === 0 ? '·' : signed(delta)} |`,
    );
  }

  const { tools, resources } = moved(before, after);
  const section = (title: string, rows: Moved[]): void => {
    if (rows.length === 0) return;
    lines.push('', `**${title}**`, '', '| | base | this PR | change |', '|---|--:|--:|--:|');
    for (const row of [...rows].sort((a, b) => Math.abs(change(b)) - Math.abs(change(a)))) {
      lines.push(
        `| ${row.label}${state(row)} | ${n(row.before ?? 0)} | ${n(row.after ?? 0)} | ${signed(change(row))} |`,
      );
    }
  };
  section(`Tools that moved (${after.widest})`, tools);
  section('Reference documents that moved (paid when read)', resources);
  if (tools.length === 0 && resources.length === 0) lines.push('', 'No tool or document changed size.');

  lines.push(
    '',
    `_${after.unit[0]?.toUpperCase() ?? ''}${after.unit.slice(1)}, not tokens: this server serves any ` +
      'model, and each vendor tokenizes differently. `pnpm manifest:size` prints the whole account._',
  );
  return lines.join('\n');
}
