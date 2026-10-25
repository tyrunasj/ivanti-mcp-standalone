// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

// Evaluates an Ivanti rule-expression tree (`RuleMeta.ReadOnlyExpressions` /
// `RequiredExpressions`, AutoFill expressions, …) against the form's current
// field values, so a field's read-only / required state — or an auto-filled
// value — can change as the user edits.
//
// This mirrors the client-side `ExpressionEvaluator.evalExpressionTree` shipped
// in Ivanti's own bundle: `node.Kind` selects a handler and the operator enums
// below match Ivanti's `BinaryOp` / `UnaryOp` numbering.
//
// Node kinds: 0 literal, 1 field reference, 2 unary, 3 binary, 4 conditional,
// 5 function call, 7 regexp, 8 set, 12 case. (6 and 9–11 are unused by Ivanti.)
//
// BinaryOp: 0 ==, 1 !=, 2 <, 3 <=, 4 >, 5 >=, 6 *, 7 /, 8 +, 9 -, 10 AND,
// 11 OR, 12 %, 13 IN, 14 NOT IN. (Date-interval and bitwise ops Ivanti also
// defines beyond 14 don't appear in form rules and aren't implemented.)
// UnaryOp: 0 negate, 1 NOT, 2 bitwise-complement.

import { DEFAULT_FUNCTIONS, str, type FunctionTable } from './functions/index.js';
import { isNumeric, isNumericString } from './value-predicates.js';

export type FieldResolver = (field: string) => unknown;

// A "stored expression" — a tenant-defined named expression referenced in an
// Ivanti expression as `$[this]Name()`. In the compiled tree it's a `Kind 16`
// node matched by its `ExpressionName` (NOT a `Kind 5` function call). One per
// file in the `stored-expressions/` folder (SRP). Gets the evaluated `args` (if
// the call has any) and a `field` reader for the open record's current values —
// e.g. `XSC_GetLongitude` reads `field('Longitude')` or the device GPS.
export interface StoredExpressionContext {
  args: unknown[];
  field(name: string): unknown;
}
export type StoredExpression = (ctx: StoredExpressionContext) => unknown;
export type StoredExpressionTable = Record<string, StoredExpression>;

export interface EvaluateOptions {
  // Extra functions merged over the pure built-ins (e.g. CurrentLoginId).
  functions?: FunctionTable;
  // Stored expressions resolved for `Kind 16` (`$[this]Name()`) nodes by their
  // `ExpressionName` (lowercased). They get field access. See `stored-expressions.ts`.
  storedExpressions?: StoredExpressionTable;
  /**
   * Called with what an expression used that this evaluator cannot answer — an unknown function,
   * a stored expression, a node kind it does not know. The value then degrades to `null`, as in
   * Ivanti's own client, but the caller learns the answer is a guess and can say so.
   */
  onUnsupported?: (what: string) => void;
}

interface Node {
  Kind?: number;
  // literal
  Value?: unknown;
  // field reference
  FieldIndex?: number;
  Details?: { Selector?: string | null } | null;
  // unary / binary
  Op?: number;
  Arg?: Node;
  Left?: Node;
  Right?: Node;
  // conditional
  Condition?: Node;
  WhenTrue?: Node;
  WhenFalse?: Node;
  // function
  FunctionName?: string;
  Arguments?: (Node | null)[];
  // stored expression (Kind 16) — a named tenant expression, `$[this]Name()`
  ExpressionName?: string;
  // regexp
  Flags?: string;
  // set
  SetValues?: Node[];
  // case
  CaseValue?: Node;
  WhenItems?: { PatternsOrValues?: Node[]; WhenAction?: Node }[];
  ElseAction?: Node;
}

interface Context {
  fieldRefs: string[];
  value: FieldResolver;
  functions: FunctionTable;
  storedExpressions: StoredExpressionTable;
  onUnsupported: (what: string) => void;
}

// Loose, string-based equality (form values are strings; null/'' are equivalent).
function eq(a: unknown, b: unknown): boolean {
  return str(a) === str(b);
}

// Ivanti coerces a string operand to a number when it cleanly parses as one,
// before ordering/arithmetic — so "5" < "10" compares numerically.
function coerce(value: unknown): unknown {
  return isNumericString(value) ? Number(value) : value;
}

function num(value: unknown): number {
  return Number(coerce(value)) || 0;
}

function resolveField(n: Node, ctx: Context): unknown {
  let ref = ctx.fieldRefs[n.FieldIndex ?? 0];
  if (typeof ref === 'string' && ref.startsWith('(old)')) {
    ref = ref.slice('(old)'.length);
  }
  const field = ref ?? n.Details?.Selector ?? undefined;
  return field ? ctx.value(field) : null;
}

function unary(n: Node, ctx: Context): unknown {
  const arg = evalNode(n.Arg, ctx);
  switch (n.Op) {
    case 0:
      return -num(arg);
    case 1:
      return !arg;
    case 2:
      return ~num(arg);
    default:
      return null;
  }
}

function binary(n: Node, ctx: Context): unknown {
  const left = evalNode(n.Left, ctx);
  // AND / OR short-circuit and return the operand value (Ivanti semantics),
  // which also lets OR act as a coalesce in auto-fill expressions.
  if (n.Op === 10) {
    return left ? evalNode(n.Right, ctx) : left;
  }
  if (n.Op === 11) {
    return left ? left : evalNode(n.Right, ctx);
  }
  const right = evalNode(n.Right, ctx);
  switch (n.Op) {
    case 0:
      return eq(left, right); // ==
    case 1:
      return !eq(left, right); // !=
    case 2:
      return num(left) < num(right); // <
    case 3:
      return num(left) <= num(right); // <=
    case 4:
      return num(left) > num(right); // >
    case 5:
      return num(left) >= num(right); // >=
    case 6:
      return num(left) * num(right); // *
    case 7:
      return num(right) === 0 ? 0 : num(left) / num(right); // /
    case 8:
      // `+` adds when both sides are numeric (incl. numeric strings — e.g. the
      // string that the built-in `Number()` returns); otherwise it concatenates.
      // Genuine (non-numeric) string concat is unchanged; a Date operand is
      // formatted (Ivanti coerces dates to `MM/dd/yyyy h:mm aa` in concat).
      return isNumeric(left) && isNumeric(right) ? num(left) + num(right) : str(left) + str(right);
    case 9:
      return num(left) - num(right); // -
    case 12:
      return num(left) % num(right); // %
    case 13:
    case 14:
    case 17: {
      // IN (13) / NOT IN (14) / set-membership (17, used by toolbar rules with a
      // Kind-8 value set) — right is a set; loose, case-insensitive membership.
      const set = Array.isArray(right) ? right : [right];
      const found = set.some((item) => eq(lower(left), lower(item)));
      return n.Op === 14 ? !found : found;
    }
    default:
      return false;
  }
}

function lower(value: unknown): unknown {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function callFunction(n: Node, ctx: Context): unknown {
  const name = (n.FunctionName ?? '').toLowerCase();
  const args = (n.Arguments ?? []).map((a) => (a === null ? null : evalNode(a, ctx)));
  const fn = ctx.functions[name];
  // Unknown functions degrade to null rather than crashing the form — and are reported.
  if (!fn) ctx.onUnsupported(`function ${n.FunctionName ?? '?'}`);
  return fn ? fn(args) : null;
}

// A stored expression (`Kind 16`, `$[this]Name()`) — resolve its `ExpressionName`
// against the registry (with field access). Unknown ⇒ null, like an unknown
// function. The `Relationship` (typically `this` = the current record) is ignored;
// the handler reads what it needs via `field`.
function callStoredExpression(n: Node, ctx: Context): unknown {
  const name = (n.ExpressionName ?? '').toLowerCase();
  const args = (n.Arguments ?? []).map((a) => (a === null ? null : evalNode(a, ctx)));
  const expr = ctx.storedExpressions[name];
  if (!expr) ctx.onUnsupported(`stored expression ${n.ExpressionName ?? '?'}`);
  return expr ? expr({ args, field: ctx.value }) : null;
}

function caseExpr(n: Node, ctx: Context): unknown {
  const subject = n.CaseValue == null ? true : evalNode(n.CaseValue, ctx);
  for (const when of n.WhenItems ?? []) {
    for (const pattern of when.PatternsOrValues ?? []) {
      const p = evalNode(pattern, ctx);
      const hit = p instanceof RegExp ? p.test(str(subject)) : eq(subject, p);
      if (hit) {
        return when.WhenAction == null ? null : evalNode(when.WhenAction, ctx);
      }
    }
  }
  return n.ElseAction == null ? null : evalNode(n.ElseAction, ctx);
}

function evalNode(node: Node | null | undefined, ctx: Context): unknown {
  if (!node || typeof node !== 'object') {
    return node ?? null;
  }
  switch (node.Kind) {
    case 0: // literal
      return node.Value;
    case 1: // field reference
      return resolveField(node, ctx);
    case 2: // unary
      return unary(node, ctx);
    case 3: // binary
      return binary(node, ctx);
    case 4: // conditional
      return evalNode(node.Condition, ctx) === true
        ? evalNode(node.WhenTrue, ctx)
        : evalNode(node.WhenFalse, ctx);
    case 5: // function call
      return callFunction(node, ctx);
    case 16: // stored expression — `$[this]Name()` (tenant named expression)
      return callStoredExpression(node, ctx);
    case 7: // regexp
      return new RegExp(str(node.Value), node.Flags ?? '');
    case 8: // set
      return (node.SetValues ?? []).map((v) => evalNode(v, ctx));
    case 12: // case
      return caseExpr(node, ctx);
    default:
      if (typeof node.Value === 'undefined') ctx.onUnsupported(`node kind ${String(node.Kind)}`);
      return typeof node.Value !== 'undefined' ? node.Value : null;
  }
}

export function evaluateExpression(
  node: unknown,
  fieldRefs: string[],
  value: FieldResolver,
  options?: EvaluateOptions,
): unknown {
  const functions = options?.functions
    ? { ...DEFAULT_FUNCTIONS, ...options.functions }
    : DEFAULT_FUNCTIONS;
  const storedExpressions = options?.storedExpressions ?? {};
  const onUnsupported = options?.onUnsupported ?? ((): void => undefined);
  return evalNode(node as Node, { fieldRefs, value, functions, storedExpressions, onUnsupported });
}

// Evaluate a rule's tree to a boolean (read-only / required) — defaults false.
export function evaluateRule(
  tree: unknown,
  fieldRefs: string[],
  value: FieldResolver,
  options?: EvaluateOptions,
): boolean {
  return evaluateExpression(tree, fieldRefs, value, options) === true;
}
