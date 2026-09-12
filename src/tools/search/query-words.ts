/**
 * What Ivanti's `$search` actually does with more than one word — all measured live against
 * `incidents` on 2026-09-12:
 *
 * | query | hits |
 * |---|---|
 * | `projector` | 3 |
 * | `boardroom` | 2 |
 * | `projector boardroom` | 2 |
 * | `projector printer` | **0** |
 * | `projector or printer` | 51 |
 * | `projector AND printer` | **0** |
 * | `"projector remote"` | **0** |
 * | `projec` | 3 |
 * | `rojector` | **0** |
 *
 * Four separate traps, none of which were documented:
 *
 * 1. **A space is AND.** Every word must appear in the same record. A tester passed the user's
 *    own sentence — "ticket about the projector remote in the boardroom" — and got zero, about a
 *    ticket that exists twice.
 * 2. **`or` is a real operator**, in either case, and is the only way to widen.
 * 3. **`AND` is not** — it is searched for literally, so writing it guarantees zero.
 * 4. **Quoting a phrase matches nothing**, and matching is prefix-from-the-start-of-a-word:
 *    `projec` finds `projector`, `rojector` finds nothing.
 */
export const QUERY_WORDS =
  'Two or three distinctive KEYWORDS — never the user’s sentence. A SPACE MEANS AND: every ' +
  'word must appear in the same record, so `projector printer` finds nothing while each word ' +
  'alone finds plenty. Use `or` to widen (`projector or clicker`); do NOT write `AND`, which is ' +
  'searched for literally, and do NOT quote a phrase, which matches nothing. Words match from ' +
  'their START — `projec` finds "projector", `rojector` finds nothing. Case-insensitive.';

/**
 * Whether the AND advice applies to this query.
 *
 * Only to a query that is narrowed by more than one word AND not already widened with `or` — a
 * query that says `projector or clicker` has been widened as far as this surface goes, so telling
 * its author to widen it would send them round the same loop.
 */
function narrowedByMultipleWords(query: string): boolean {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.some((word) => word.toLowerCase() === 'or')) return false;
  return words.length > 1;
}

/**
 * The advice a zero-hit answer should carry, in the response and not only in the description.
 *
 * A long conversation scrolls the manifest out of attention and leaves only the payload in front
 * of the model — and an empty payload reads as a clean negative. Two testers reported "there is
 * no such record" from a query that was merely too narrow.
 */
export function noHitsNote(query: string): string {
  const narrowed =
    narrowedByMultipleWords(query)
      ? 'This query has more than one word, and a space means AND — every word had to appear in ' +
        'the same record. Retry with the single most distinctive word, or join them with `or`, ' +
        'BEFORE concluding nothing matches. '
      : '';

  return (
    `${narrowed}No match IN THE INDEXED TEXT — the subject, description and notes. This is not ` +
    'the same as no such record: a value held in a structured field (a category, a chassis type, ' +
    'a filename) does not match here even when it is exactly the word searched. Measured: ' +
    '`laptop` finds neither computer whose ChassisType is literally "Laptop". Confirm with ' +
    'list_records and an `eq` filter before reporting none.'
  );
}
