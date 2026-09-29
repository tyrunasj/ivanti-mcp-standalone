// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * Whether a FREE field holds what was written, allowing for how Ivanti stores it.
 *
 * A validated field is compared exactly, because its stored value is the option's own spelling and
 * this server resolved that spelling itself. A free field is stored the way Ivanti renders it, so
 * an exact comparison would report values that took as values that did not: a date comes back as
 * an instant in UTC, a number without the quotes it was sent in, a flag as a boolean, text with its
 * whitespace moved. Each allowance here is one of those, and none of them lets through a value that
 * did NOT take — a cleared field, the old value, a different one.
 */

export type Verdict = 'same' | 'different' | 'incomparable';

/**
 * Markup in either copy. A rich-text field is stored as Ivanti re-renders it — wrapped, entities
 * encoded, whitespace moved — so a character comparison would call a stored value missing. Such a
 * field is reported as not compared rather than passed or failed on a guess.
 */
const MARKUP = /<\/?[a-z][^>]*>/i;

/** The widest real UTC offsets, -12:00 to +14:00: how far a zone-less time can move in storage. */
const ZONELESS_SLACK_MS = 14 * 60 * 60 * 1000;

const NUMERIC = /^Edm\.(Byte|SByte|Int16|Int32|Int64|Decimal|Double|Single)$/;
const TEMPORAL = /^Edm\.(DateTimeOffset|DateTime|Date)$/;
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?<zone>Z|[+-]\d{2}:?\d{2})?)?$/i;

const empty = (value: unknown): boolean => value === null || value === undefined || value === '';

/** Scalars as themselves; anything structured serialised rather than becoming '[object Object]'. */
export function comparable(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value) ?? '';
}

function asBoolean(value: unknown): boolean | undefined {
  // Null reads as false: a nullable flag that was never set is off, and a write of `false` that
  // reads back null has not failed in any sense a person would recognise.
  if (empty(value)) return false;
  if (typeof value === 'boolean') return value;
  const text = comparable(value).trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * An ISO date as an instant, and whether it named its zone.
 *
 * Not `Date.parse` alone: that reads a zone-less date-TIME in the zone of the machine this server
 * runs on, which is nobody's intent. A zone-less value is read as UTC here, and the comparison
 * allows for the tenant having read it in its own zone instead.
 */
function asInstant(value: unknown): { at: number; zoned: boolean } | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const match = ISO_DATE.exec(text);
  if (match === null) return undefined;

  const zoned = match.groups?.['zone'] !== undefined;
  const dateOnly = text.length === 10;
  const at = Date.parse(zoned || dateOnly ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isNaN(at) ? undefined : { at, zoned };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A field that renders HTML may store `a & b` as `a &amp; b` with no tag in sight. */
const decodeEntities = (text: string): string =>
  text.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/giu, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

/**
 * Entities, case, line endings and runs of whitespace — the ways a stored copy of text differs
 * from a value that took. Case is folded too: Ivanti spells a value its own way (it already does
 * for every picklist), and a value that came back re-cased was stored, not dropped.
 */
const foldText = (value: unknown): string =>
  decodeEntities(comparable(value)).replace(/\s+/gu, ' ').trim().toLowerCase();

/**
 * @param type the field's CSDL type, when the schema is in hand. Without it the value's own shape
 *   decides — a JS number is compared as a number, an ISO string as a date.
 */
export function compareStored(intended: unknown, stored: unknown, type?: string): Verdict {
  if (typeof intended === 'object' && intended !== null) return 'incomparable';

  if (type === 'Edm.Boolean' || typeof intended === 'boolean') {
    const [wrote, holds] = [asBoolean(intended), asBoolean(stored)];
    if (wrote !== undefined && holds !== undefined) return wrote === holds ? 'same' : 'different';
  }

  // Before the markup check: a rich-text value that stored as NOTHING is not a rendering question.
  if (empty(intended) || empty(stored)) {
    return empty(intended) && empty(stored) ? 'same' : 'different';
  }

  if (MARKUP.test(comparable(intended)) || MARKUP.test(comparable(stored))) return 'incomparable';

  if ((type !== undefined && NUMERIC.test(type)) || typeof intended === 'number') {
    const [wrote, holds] = [asNumber(intended), asNumber(stored)];
    if (wrote !== undefined && holds !== undefined) {
      const scale = Math.max(1, Math.abs(wrote), Math.abs(holds));
      return Math.abs(wrote - holds) <= 1e-9 * scale ? 'same' : 'different';
    }
  }

  if (type === undefined || TEMPORAL.test(type)) {
    const [wrote, holds] = [asInstant(intended), asInstant(stored)];
    if (wrote !== undefined && holds !== undefined) {
      // A zoned time must land on the same instant, give or take the milliseconds Ivanti drops. A
      // zone-less one is read in whatever zone the tenant keeps, so it may land up to a day's
      // offsets away — an allowance that still catches a value that did not take at all.
      const slack = wrote.zoned ? 1000 : ZONELESS_SLACK_MS;
      return Math.abs(wrote.at - holds.at) < slack ? 'same' : 'different';
    }
  }

  return foldText(intended) === foldText(stored) ? 'same' : 'different';
}
