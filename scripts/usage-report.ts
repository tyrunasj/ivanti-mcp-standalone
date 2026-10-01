// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * What each tool put into conversations, from the server's own log.
 *
 *   pnpm usage:report server.log                         # sizes in characters
 *   pnpm usage:report server.log --chars-per-token 3.5   # a rough token figure, for one model family
 *   kubectl logs deploy/ivanti-mcp | pnpm usage:report   # from stdin
 *   pnpm usage:report server.log --json                  # the figures, for a dashboard or a diff
 *
 * It reads the `tool finished` and `resource read` lines, which the server writes at info.
 *
 * Characters by default, because the server serves any model and each vendor tokenizes differently.
 * `--chars-per-token` converts at a ratio YOU supply — the vendor's own figure for the model your
 * clients run — and the report labels the result an estimate.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseLog, summarise, type UsageReport } from './lib/usage-report.js';
import { analyseWaste, type Waste } from './lib/waste.js';

const { values, positionals } = parseArgs({
  options: {
    'chars-per-token': { type: 'string' },
    json: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const ratio = values['chars-per-token'] === undefined ? undefined : Number(values['chars-per-token']);
if (ratio !== undefined && !(ratio > 0)) {
  console.error('--chars-per-token must be a positive number, e.g. 3.5.');
  process.exit(2);
}

const text =
  positionals.length === 0
    ? readFileSync(0, 'utf8')
    : positionals.map((file) => readFileSync(file, 'utf8')).join('\n');

const parsed = parseLog(text);
const report = summarise(parsed);
const waste = analyseWaste(parsed.tools);

if (values.json) {
  console.log(JSON.stringify({ ...report, waste }, null, 2));
  process.exit(0);
}

print(report, waste);

function print(report: UsageReport, waste: Waste): void {
  if (report.calls === 0 && report.resources.length === 0) {
    console.log(
      'No `tool finished` lines found. They are written at LOG_LEVEL=info or lower, by a server ' +
        'new enough to write them.',
    );
    return;
  }

  const unit = ratio === undefined ? 'characters' : 'tokens (estimated)';
  const size = (chars: number): string =>
    Math.round(ratio === undefined ? chars : chars / ratio).toLocaleString('en-US');

  console.log(
    `${String(report.calls)} tool calls in ${String(report.conversations)} conversation(s)` +
      (report.skipped === 0 ? '' : `; ${String(report.skipped)} line(s) were not JSON`) +
      `. Sizes in ${unit}` +
      (ratio === undefined
        ? ' — pass --chars-per-token for a rough token figure for one model family.'
        : ` at ${String(ratio)} characters per token.`),
  );
  console.log('Result sizes are paid again on every later turn of the conversation.\n');

  printWaste(waste, size);

  console.log('\nPer tool, dearest first:');
  table(
    [
      'tool',
      'calls',
      'not ok',
      'retried',
      'result p50',
      'p95',
      'max',
      'total',
      'args p50',
      'ivanti/call',
      'ms p95',
    ],
    report.tools.map((tool) => [
      tool.tool,
      String(tool.calls),
      String(tool.notOk),
      String(tool.retries),
      size(tool.resultChars.p50),
      size(tool.resultChars.p95),
      size(tool.resultChars.max),
      size(tool.resultChars.total),
      size(tool.argsChars.p50),
      tool.ivantiRequestsPerCall.toFixed(1),
      String(tool.ms.p95),
    ]),
  );

  const failing = report.tools.filter((tool) => tool.notOk > 0);
  if (failing.length > 0) {
    console.log('\nHow calls failed — the most frequent refusal is the warning a description is missing:');
    for (const tool of failing) {
      const outcomes = Object.entries(tool.outcomes)
        .sort((a, b) => b[1] - a[1])
        .map(([outcome, count]) => `${outcome} ×${String(count)}`)
        .join(', ');
      const retried =
        tool.retries === 0 ? '' : `; ${size(tool.retriedChars)} spent on attempts that were retried`;
      console.log(printable(`  ${tool.tool}: ${outcomes}${retried}`));
    }
  }

  if (report.resources.length > 0) {
    console.log('\nReference documents read:');
    table(
      ['uri', 'reads', 'total'],
      report.resources.map((resource) => [
        resource.uri,
        String(resource.reads),
        size(resource.resultChars),
      ]),
    );
  }

  if (waste.versions.length > 0) {
    console.log(
      '\nBy version of the instructions and client — the comparison a description change is judged by:',
    );
    table(
      ['manifest', 'client', 'conversations', 'calls each', 'failed', 'waste'],
      waste.versions.map((version) => [
        version.manifest,
        version.client,
        String(version.conversations),
        version.callsPerConversation.toFixed(1),
        percent(version.failedShare),
        percent(version.wasteShare),
      ]),
    );
  }
}

function percent(share: number): string {
  return `${String(Math.round(share * 100))}%`;
}

function printWaste(waste: Waste, size: (chars: number) => string): void {
  if (waste.calls === 0) return;
  console.log(
    'Waste — calls that failed, came back empty and were asked again differently, or repeated an ' +
      'identical call:',
  );
  console.log(
    `  ${String(waste.wastedCalls)} of ${String(waste.calls)} calls ` +
      `(${percent(waste.calls === 0 ? 0 : waste.wastedCalls / waste.calls)}) · ` +
      `${size(waste.wasted)} of ${size(waste.volume)} context sent ` +
      `(${percent(waste.volume === 0 ? 0 : waste.wasted / waste.volume)})`,
  );
  console.log(
    '  Context: every call is a request that re-sends the manifest and everything before it, and ' +
      'its own result rides along on every later request.' +
      (waste.manifestKnown ? '' : ' Some lines carry no manifest size (an older server), so it is left out.'),
  );

  table(
    ['pattern', 'calls', 'context'],
    [
      ['failed', String(waste.patterns.failed.calls), size(waste.patterns.failed.chars)],
      [
        'empty, then asked again differently',
        String(waste.patterns.emptyThenAskedAgain.calls),
        size(waste.patterns.emptyThenAskedAgain.chars),
      ],
      ['identical call repeated', String(waste.patterns.repeated.calls), size(waste.patterns.repeated.chars)],
      ['same refusal twice in a row', String(waste.sameRefusalAgain), ''],
      ['conversations that ended on a failure', String(waste.endedOnFailure), ''],
    ],
  );

  if (waste.recovery.length > 0) {
    console.log('\nAfter each refusal — does its message tell the model what to do instead?');
    table(
      ['outcome', 'seen', 'next call ok', 'same again'],
      waste.recovery.map((row) => [
        row.outcome,
        String(row.seen),
        `${String(row.recovered)} (${percent(row.recovered / row.seen)})`,
        String(row.sameAgain),
      ]),
    );
  }

  if (waste.switches.length > 0) {
    console.log('\nSwitched tool after a failure or an empty answer — descriptions that overlap:');
    for (const change of waste.switches.slice(0, 10)) {
      console.log(printable(`  ${change.from} → ${change.to} ×${String(change.count)}`));
    }
  }

  const lookups = waste.lookupsBeforeAnswer;
  console.log(
    `\nLookups before the first answer, per conversation: p50 ${String(lookups.p50)} · ` +
      `p95 ${String(lookups.p95)} · max ${String(lookups.max)}`,
  );
}

/**
 * Log fields reach the terminal: `client` is whatever name the connecting client chose, so an escape
 * sequence in it would otherwise be run by the operator's terminal. Control characters go.
 */
function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function table(header: string[], cells: string[][]): void {
  const rows = cells.map((row) => row.map(printable));
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  // The first column is a name and reads left to right; the rest are figures.
  const line = (row: string[]): string =>
    row
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
      )
      .join('  ');
  console.log(line(header));
  for (const row of rows) console.log(line(row));
}
