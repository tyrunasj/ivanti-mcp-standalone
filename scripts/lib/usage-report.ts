// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * Reads the server's own `tool finished` and `resource read` lines back into a per-tool account of
 * what each call put into the conversation.
 *
 * Pure: text in, figures out. The CLI in `scripts/usage-report.ts` does the reading and printing.
 */

export interface ToolLine {
  time: string;
  tool: string;
  /** Absent under stdio. */
  sessionId?: string;
  /** Names one conversation across sessions and processes; absent from older servers. */
  conversation?: string;
  /** The same for identical arguments in one process — never the arguments themselves. */
  argsHash?: string;
  /** Rows the call read from Ivanti collections; 0 is an empty answer, absent is "read none". */
  rowsRead?: number;
  /** Which version of the instructions, and what they cost per request. */
  manifest?: string;
  manifestChars?: number;
  /** The client, as it named itself — the nearest thing to the model a server can know. */
  client?: string;
  outcome: string;
  argsChars: number;
  resultChars: number;
  ivantiRequests: number;
  ms: number;
}

/** The conversation a line belongs to, from the best marker it carries. */
export function conversationOf(line: ToolLine): string {
  return line.conversation ?? line.sessionId ?? 'stdio';
}

export interface ResourceLine {
  uri: string;
  resultChars: number;
}

export interface Distribution {
  p50: number;
  p95: number;
  max: number;
  total: number;
}

export interface ToolStats {
  tool: string;
  calls: number;
  /** Calls that ended in anything but `ok`. */
  notOk: number;
  /** Calls that repeated the same tool straight after it failed — the attempt a warning should have saved. */
  retries: number;
  /** What the failed attempts that were then retried put into the conversation. */
  retriedChars: number;
  resultChars: Distribution;
  argsChars: Distribution;
  ivantiRequestsPerCall: number;
  ms: Distribution;
  outcomes: Record<string, number>;
}

export interface UsageReport {
  calls: number;
  conversations: number;
  /** Lines carrying no JSON object. JSON that is not one of ours is ignored, not counted. */
  skipped: number;
  tools: ToolStats[];
  resources: { uri: string; reads: number; resultChars: number }[];
}

/**
 * One log line, from wherever it was collected.
 *
 * A container runtime or collector often prefixes the JSON (`2026-09-28T… stdout F {…}`), so the
 * object is taken from the first brace rather than the start of the line.
 */
function parseLine(line: string): Record<string, unknown> | undefined {
  const start = line.indexOf('{');
  if (start === -1) return undefined;
  try {
    const parsed: unknown = JSON.parse(line.slice(start));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

export function parseLog(text: string): {
  tools: ToolLine[];
  resources: ResourceLine[];
  skipped: number;
} {
  const tools: ToolLine[] = [];
  const resources: ResourceLine[] = [];
  let skipped = 0;

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const line = parseLine(raw);
    if (line?.message === 'tool finished' && typeof line.tool === 'string') {
      const text = (key: string): Record<string, string> =>
        typeof line[key] === 'string' ? { [key]: line[key] } : {};
      const count = (key: string): Record<string, number> =>
        typeof line[key] === 'number' ? { [key]: line[key] } : {};
      tools.push({
        time: typeof line.time === 'string' ? line.time : '',
        tool: line.tool,
        ...text('sessionId'),
        ...text('conversation'),
        ...text('argsHash'),
        ...count('rowsRead'),
        ...text('manifest'),
        ...count('manifestChars'),
        ...text('client'),
        outcome: typeof line.outcome === 'string' ? line.outcome : 'ok',
        argsChars: num(line.argsChars),
        resultChars: num(line.resultChars) + num(line.nonTextChars),
        ivantiRequests: num(line.ivantiRequests),
        ms: num(line.ms),
      });
    } else if (line?.message === 'resource read' && typeof line.uri === 'string') {
      resources.push({ uri: line.uri, resultChars: num(line.resultChars) });
    } else if (line === undefined) {
      skipped += 1;
    }
  }

  return { tools, resources, skipped };
}

/** Nearest-rank: the value at or below which `p` of them fall. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function distribution(values: readonly number[]): Distribution {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    // Not `Math.max(...values)`: spreading a large log's values overflows the call stack.
    max: values.reduce((most, value) => Math.max(most, value), 0),
    total: values.reduce((sum, value) => sum + value, 0),
  };
}

export function summarise(parsed: ReturnType<typeof parseLog>): UsageReport {
  const byTool = new Map<string, ToolLine[]>();
  const byConversation = new Map<string, ToolLine[]>();
  for (const line of parsed.tools) {
    // Appended in place: copying the array on every line made a large log quadratic.
    const forTool = byTool.get(line.tool) ?? [];
    forTool.push(line);
    byTool.set(line.tool, forTool);
    const key = conversationOf(line);
    const forConversation = byConversation.get(key) ?? [];
    forConversation.push(line);
    byConversation.set(key, forConversation);
  }

  // A retry is the same tool called again, in the same conversation, straight after it failed.
  const retries = new Map<string, { count: number; chars: number }>();
  for (const calls of byConversation.values()) {
    const ordered = [...calls].sort((a, b) => a.time.localeCompare(b.time));
    ordered.forEach((call, index) => {
      const next = ordered[index + 1];
      if (call.outcome === 'ok' || next?.tool !== call.tool) return;
      const seen = retries.get(call.tool) ?? { count: 0, chars: 0 };
      retries.set(call.tool, {
        count: seen.count + 1,
        chars: seen.chars + call.argsChars + call.resultChars,
      });
    });
  }

  const tools = [...byTool.entries()]
    .map(([tool, calls]): ToolStats => {
      const outcomes: Record<string, number> = {};
      for (const call of calls) {
        if (call.outcome !== 'ok') outcomes[call.outcome] = (outcomes[call.outcome] ?? 0) + 1;
      }
      return {
        tool,
        calls: calls.length,
        notOk: calls.filter((call) => call.outcome !== 'ok').length,
        retries: retries.get(tool)?.count ?? 0,
        retriedChars: retries.get(tool)?.chars ?? 0,
        resultChars: distribution(calls.map((call) => call.resultChars)),
        argsChars: distribution(calls.map((call) => call.argsChars)),
        ivantiRequestsPerCall:
          calls.reduce((sum, call) => sum + call.ivantiRequests, 0) / calls.length,
        ms: distribution(calls.map((call) => call.ms)),
        outcomes,
      };
    })
    // Dearest first: what a tool put into conversations in all, arguments and results together.
    .sort(
      (a, b) =>
        b.resultChars.total + b.argsChars.total - (a.resultChars.total + a.argsChars.total),
    );

  const byUri = new Map<string, { reads: number; resultChars: number }>();
  for (const read of parsed.resources) {
    const seen = byUri.get(read.uri) ?? { reads: 0, resultChars: 0 };
    byUri.set(read.uri, { reads: seen.reads + 1, resultChars: seen.resultChars + read.resultChars });
  }

  return {
    calls: parsed.tools.length,
    conversations: byConversation.size,
    skipped: parsed.skipped,
    tools,
    resources: [...byUri.entries()]
      .map(([uri, seen]) => ({ uri, ...seen }))
      .sort((a, b) => b.resultChars - a.resultChars),
  };
}
