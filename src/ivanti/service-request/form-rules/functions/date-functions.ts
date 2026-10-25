// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

// Date/time (clock) functions: currentDateTime/now/today/tomorrow/yesterday/
// utcNow, add{Years…Seconds}, dateAdd, dateDiff, datePart, diff{Seconds…Years},
// beginningOf/endOf {Day,Month,Year}, formatDate.
//
// Ivanti's date library uses moment + the user's timezone. We use native `Date`
// in UTC, which matches the deterministic operations (add/diff/part on a given
// date); the timezone/locale-relative helpers (`local*`, `relativeDate`,
// `lastNDays`, .NET `formatDate` masks) are intentionally not reimplemented here.
//
// The functions that need the current time take it from the injected `now`; the
// rest are pure — keeping evaluation deterministic and testable.

import { formatDateTime } from './coercion.js'
import type { FunctionTable } from './coercion.js';

type Unit = 'years' | 'quarters' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds';

const MS: Record<string, number> = {
  millisecond: 1,
  second: 1e3,
  minute: 6e4,
  hour: 36e5,
  day: 864e5,
  week: 6048e5,
};

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function addUnit(date: Date, unit: Unit | 'milliseconds', n: number): Date {
  const d = new Date(date.getTime());
  switch (unit) {
    case 'years':
      d.setUTCFullYear(d.getUTCFullYear() + n);
      break;
    case 'quarters':
      d.setUTCMonth(d.getUTCMonth() + n * 3);
      break;
    case 'months':
      d.setUTCMonth(d.getUTCMonth() + n);
      break;
    case 'weeks':
      d.setUTCDate(d.getUTCDate() + n * 7);
      break;
    case 'days':
      d.setUTCDate(d.getUTCDate() + n);
      break;
    case 'hours':
      d.setUTCHours(d.getUTCHours() + n);
      break;
    case 'minutes':
      d.setUTCMinutes(d.getUTCMinutes() + n);
      break;
    case 'seconds':
      d.setUTCSeconds(d.getUTCSeconds() + n);
      break;
    case 'milliseconds':
      d.setUTCMilliseconds(d.getUTCMilliseconds() + n);
      break;
  }
  return d;
}

// `add<Unit>([offset, date])` → the date shifted by `offset` units.
function adder(unit: Unit): (args: unknown[]) => Date | null {
  return (a) => {
    const date = toDate(a[1]);
    return date ? addUnit(date, unit, Number(a[0]) || 0) : null;
  };
}

function datePart(part: string, date: Date): number | null {
  switch (part.toLowerCase()) {
    case 'millisecond':
      return date.getUTCMilliseconds();
    case 'second':
      return date.getUTCSeconds();
    case 'minute':
      return date.getUTCMinutes();
    case 'hour':
      return date.getUTCHours();
    case 'day':
      return date.getUTCDate();
    case 'dayofyear':
      return Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / MS['day']!) + 1;
    case 'weekday':
      return date.getUTCDay() + 1;
    case 'month':
      return date.getUTCMonth() + 1;
    case 'quarter':
      return Math.floor(date.getUTCMonth() / 3) + 1;
    case 'year':
      return date.getUTCFullYear();
    default:
      return null;
  }
}

function startOf(date: Date, unit: 'day' | 'month' | 'year'): Date {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  if (unit === 'month') {
    d.setUTCDate(1);
  } else if (unit === 'year') {
    d.setUTCMonth(0, 1);
  }
  return d;
}

function endOf(date: Date, unit: 'day' | 'month' | 'year'): Date {
  const start = startOf(date, unit);
  const next =
    unit === 'day'
      ? addUnit(start, 'days', 1)
      : unit === 'month'
        ? addUnit(start, 'months', 1)
        : addUnit(start, 'years', 1);
  return new Date(next.getTime() - 1);
}

export function clockFunctions(now: () => Date): FunctionTable {
  const startOfDay = (): Date => startOf(now(), 'day');
  const functions: FunctionTable = {
    now: () => now(),
    utcnow: () => now(),
    currentdatetime: () => now(),
    currentutcdatetime: () => now(),
    currentdate: () => startOfDay(),
    today: () => startOfDay(),
    tomorrow: () => addUnit(startOfDay(), 'days', 1),
    yesterday: () => addUnit(startOfDay(), 'days', -1),
    // Ivanti's CurrentDateStr is `(new Date).toLocaleDateString()` — date only.
    currentdatestr: () => now().toLocaleDateString(),

    // add<Unit>([offset, date])
    addyears: adder('years'),
    addquarters: adder('quarters'),
    addmonths: adder('months'),
    addweeks: adder('weeks'),
    adddays: adder('days'),
    addhours: adder('hours'),
    addminutes: adder('minutes'),
    addseconds: adder('seconds'),

    // dateAdd([interval, offset, date])
    dateadd: (a) => {
      const date = toDate(a[2]);
      if (!date) {
        return null;
      }
      const interval = String(a[0]).toLowerCase();
      const unit = interval === 'millisecond' ? 'milliseconds' : (`${interval}s` as Unit);
      return addUnit(date, unit, Number(a[1]) || 0);
    },
    // dateDiff([interval, d1, d2]) → ceil((d1 - d2) / interval).
    datediff: (a) => {
      const d1 = toDate(a[1]);
      const d2 = toDate(a[2]);
      const divisor = MS[String(a[0]).toLowerCase()];
      if (!d1 || !d2 || !divisor) {
        return null;
      }
      return Math.ceil((d1.getTime() - d2.getTime()) / divisor);
    },
    // datePart([part, date]) → the requested UTC component.
    datepart: (a) => {
      const date = toDate(a[1]);
      return date ? datePart(String(a[0]), date) : null;
    },

    // diff<Unit>([d1, d2]) → d2 − d1 in whole units.
    diffseconds: diff('second'),
    diffminutes: diff('minute'),
    diffhours: diff('hour'),
    diffdays: diff('day'),
    diffweeks: diff('week'),
    diffmonths: monthDiff(1),
    diffquarters: monthDiff(3),
    diffyears: monthDiff(12),

    // beginningOf / endOf [date]
    beginningofday: edge('day', 'start'),
    beginningofmonth: edge('month', 'start'),
    beginningofyear: edge('year', 'start'),
    endofday: edge('day', 'end'),
    endofmonth: edge('month', 'end'),
    endofyear: edge('year', 'end'),

    // formatDate([date]) → MM/dd/yyyy h:mm aa (Ivanti default).
    formatdate: (a) => {
      const date = toDate(a[0]);
      return date ? formatDateTime(date) : '';
    },
    formatdatetime: (a) => {
      const date = toDate(a[0]);
      return date ? formatDateTime(date) : '';
    },
  };
  return functions;
}

function diff(unit: keyof typeof MS): (args: unknown[]) => number | null {
  return (a) => {
    const d1 = toDate(a[0]);
    const d2 = toDate(a[1]);
    return d1 && d2 ? Math.trunc((d2.getTime() - d1.getTime()) / (MS[unit] ?? 1)) : null;
  };
}

function monthDiff(monthsPerUnit: number): (args: unknown[]) => number | null {
  return (a) => {
    const d1 = toDate(a[0]);
    const d2 = toDate(a[1]);
    if (!d1 || !d2) {
      return null;
    }
    const months =
      (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth());
    return Math.trunc(months / monthsPerUnit);
  };
}

function edge(
  unit: 'day' | 'month' | 'year',
  which: 'start' | 'end',
): (args: unknown[]) => Date | null {
  return (a) => {
    const date = toDate(a[0]);
    if (!date) {
      return null;
    }
    return which === 'start' ? startOf(date, unit) : endOf(date, unit);
  };
}
