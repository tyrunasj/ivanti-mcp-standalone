// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { conversationOf, percentile, type ToolLine } from './usage-report.js';

/**
 * The turns a model spent getting it wrong, read from the server's usage lines.
 *
 * A misleading instruction does not show up as its own length. It shows up as calls: refused ones,
 * empty ones asked again differently, identical ones repeated, a hop to another tool. Each such call
 * is a whole extra request — the manifest re-sent, everything before it re-sent — and its own
 * result then rides along on every later request. This names those calls, prices them in context
 * characters, and groups them by the version of the instructions that was in force, so a change to
 * a description can be judged by whether the waste went down.
 *
 * What it cannot see: turns where the model only thought, or asked the person something it did not
 * need to, and whether the final answer was right. Those need transcripts — the benchmark.
 */

/** Calls that only find out what to ask; everything else is an answer, or identity. */
const LOOKUP = new Set([
  'list_business_objects',
  'get_object_metadata',
  'get_link_fields',
  'get_pick_list_values',
  'get_pick_list_constraints',
]);
const IDENTITY = new Set(['act_as', 'switch_role', 'get_version']);

export interface PatternCost {
  calls: number;
  /** Context characters: see `callCost`. */
  chars: number;
}

export interface Waste {
  calls: number;
  conversations: number;
  /** Calls in any of the three waste patterns, counted once however many they match. */
  wastedCalls: number;
  /** All context sent across all conversations, and the part the wasted calls account for. */
  volume: number;
  wasted: number;
  /** False when some lines carry no manifest size — then context cost leaves the manifest out. */
  manifestKnown: boolean;
  patterns: {
    failed: PatternCost;
    emptyThenAskedAgain: PatternCost;
    repeated: PatternCost;
  };
  /** The same refusal straight after itself: the message did not tell the model what to do. */
  sameRefusalAgain: number;
  /** Conversations whose last call failed or came back empty — the model gave up, or the person did. */
  endedOnFailure: number;
  recovery: { outcome: string; seen: number; recovered: number; sameAgain: number }[];
  switches: { from: string; to: string; count: number }[];
  /** Lookup calls before the first call that answers something, per conversation. */
  lookupsBeforeAnswer: { p50: number; p95: number; max: number };
  versions: {
    manifest: string;
    client: string;
    conversations: number;
    callsPerConversation: number;
    failedShare: number;
    wasteShare: number;
  }[];
}

const failed = (call: ToolLine): boolean => call.outcome !== 'ok';
const empty = (call: ToolLine): boolean => call.outcome === 'ok' && call.rowsRead === 0;

/**
 * What one call cost the conversation, in context characters.
 *
 * The request that produced it re-sent the manifest and everything before it; and its own
 * arguments and result are then re-sent with every request after it — `after` of them. Removing
 * the call would save all of that, which is what makes an early mistake dearer than a late one.
 * Model output beyond the arguments, and prompt caching, are outside what a server can see.
 */
export function callCost(manifestChars: number, before: number, call: ToolLine, after: number): number {
  return manifestChars + before + (call.argsChars + call.resultChars) * after;
}

interface Scored {
  call: ToolLine;
  next?: ToolLine;
  cost: number;
  failed: boolean;
  emptyThenAskedAgain: boolean;
  repeated: boolean;
}

/** One conversation's calls, in order, each priced and classified. */
function score(calls: readonly ToolLine[]): { scored: Scored[]; volume: number } {
  const ordered = [...calls].sort((a, b) => a.time.localeCompare(b.time));
  const n = ordered.length;
  const seen = new Set<string>();
  let before = 0;
  let volume = 0;
  const scored = ordered.map((call, index): Scored => {
    const next = ordered[index + 1];
    const manifest = call.manifestChars ?? 0;
    // A request is sent for every call and once more for the final answer: n + 1 in all.
    volume += manifest + before;
    const identity = call.argsHash === undefined ? undefined : `${call.tool} ${call.argsHash}`;
    const repeated = identity !== undefined && seen.has(identity);
    if (identity !== undefined) seen.add(identity);
    const entry: Scored = {
      call,
      ...(next === undefined ? {} : { next }),
      cost: callCost(manifest, before, call, n - index),
      failed: failed(call),
      emptyThenAskedAgain:
        empty(call) && next?.tool === call.tool && next.argsHash !== call.argsHash,
      repeated,
    };
    before += call.argsChars + call.resultChars;
    return entry;
  });
  volume += (ordered.at(-1)?.manifestChars ?? 0) + before;
  return { scored, volume };
}

export function analyseWaste(lines: readonly ToolLine[]): Waste {
  const byConversation = new Map<string, ToolLine[]>();
  for (const line of lines) {
    const key = conversationOf(line);
    const calls = byConversation.get(key) ?? [];
    calls.push(line);
    byConversation.set(key, calls);
  }

  const patterns: Waste['patterns'] = {
    failed: { calls: 0, chars: 0 },
    emptyThenAskedAgain: { calls: 0, chars: 0 },
    repeated: { calls: 0, chars: 0 },
  };
  const recovery = new Map<string, { seen: number; recovered: number; sameAgain: number }>();
  const switches = new Map<string, number>();
  const lookups: number[] = [];
  const versions = new Map<
    string,
    { manifest: string; client: string; conversations: number; calls: number; failed: number; volume: number; wasted: number }
  >();
  let wastedCalls = 0;
  let volume = 0;
  let wasted = 0;
  let sameRefusalAgain = 0;
  let endedOnFailure = 0;

  for (const calls of byConversation.values()) {
    const { scored, volume: conversationVolume } = score(calls);
    volume += conversationVolume;
    let conversationWaste = 0;

    for (const entry of scored) {
      const { call, next, cost } = entry;
      if (entry.failed) patterns.failed = add(patterns.failed, cost);
      if (entry.emptyThenAskedAgain) patterns.emptyThenAskedAgain = add(patterns.emptyThenAskedAgain, cost);
      if (entry.repeated) patterns.repeated = add(patterns.repeated, cost);
      if (entry.failed || entry.emptyThenAskedAgain || entry.repeated) {
        wastedCalls += 1;
        conversationWaste += cost;
      }

      if (entry.failed && next !== undefined) {
        const seen = recovery.get(call.outcome) ?? { seen: 0, recovered: 0, sameAgain: 0 };
        const again = next.tool === call.tool && next.outcome === call.outcome;
        if (again) sameRefusalAgain += 1;
        recovery.set(call.outcome, {
          seen: seen.seen + 1,
          recovered: seen.recovered + (next.outcome === 'ok' ? 1 : 0),
          sameAgain: seen.sameAgain + (again ? 1 : 0),
        });
      }
      // Into `act_as` is the identity gate doing its job — already counted as the refused call —
      // not two descriptions a model could not tell apart.
      if (
        (entry.failed || empty(call)) &&
        next !== undefined &&
        next.tool !== call.tool &&
        !IDENTITY.has(next.tool)
      ) {
        const key = `${call.tool}\u0000${next.tool}`;
        switches.set(key, (switches.get(key) ?? 0) + 1);
      }
    }
    wasted += conversationWaste;

    const last = scored.at(-1)?.call;
    if (last !== undefined && (failed(last) || empty(last))) endedOnFailure += 1;

    // An answer is a call that succeeded: a refused query has not found anything out yet.
    const firstAnswer = scored.findIndex(
      ({ call }) => !LOOKUP.has(call.tool) && !IDENTITY.has(call.tool) && !failed(call),
    );
    const upTo = firstAnswer === -1 ? scored : scored.slice(0, firstAnswer);
    lookups.push(upTo.filter(({ call }) => LOOKUP.has(call.tool)).length);

    const first = scored[0]?.call;
    const version = `${first?.manifest ?? 'unknown'}\u0000${first?.client ?? 'unknown'}`;
    const tally = versions.get(version) ?? {
      manifest: first?.manifest ?? 'unknown',
      client: first?.client ?? 'unknown',
      conversations: 0,
      calls: 0,
      failed: 0,
      volume: 0,
      wasted: 0,
    };
    versions.set(version, {
      ...tally,
      conversations: tally.conversations + 1,
      calls: tally.calls + scored.length,
      failed: tally.failed + scored.filter((entry) => entry.failed).length,
      volume: tally.volume + conversationVolume,
      wasted: tally.wasted + conversationWaste,
    });
  }

  return {
    calls: lines.length,
    conversations: byConversation.size,
    wastedCalls,
    volume,
    wasted,
    manifestKnown: lines.every((line) => line.manifestChars !== undefined),
    patterns,
    sameRefusalAgain,
    endedOnFailure,
    recovery: [...recovery.entries()]
      .map(([outcome, tally]) => ({ outcome, ...tally }))
      .sort((a, b) => b.seen - a.seen),
    switches: [...switches.entries()]
      .map(([key, count]) => {
        const [from = '', to = ''] = key.split('\u0000');
        return { from, to, count };
      })
      .sort((a, b) => b.count - a.count),
    lookupsBeforeAnswer: {
      p50: percentile(lookups, 50),
      p95: percentile(lookups, 95),
      max: lookups.reduce((most, value) => Math.max(most, value), 0),
    },
    versions: [...versions.values()]
      .map((tally) => ({
        manifest: tally.manifest,
        client: tally.client,
        conversations: tally.conversations,
        callsPerConversation: tally.calls / tally.conversations,
        failedShare: tally.calls === 0 ? 0 : tally.failed / tally.calls,
        wasteShare: tally.volume === 0 ? 0 : tally.wasted / tally.volume,
      }))
      .sort((a, b) => b.conversations - a.conversations),
  };
}

const add = (pattern: PatternCost, cost: number): PatternCost => ({
  calls: pattern.calls + 1,
  chars: pattern.chars + cost,
});
