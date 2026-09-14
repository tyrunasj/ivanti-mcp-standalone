// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * What an empty answer means, said in the payload rather than only in a description.
 *
 * Five rounds of blind testing kept landing on the same finding from different angles: a zero is
 * the moment the reassurance needs to be in front of the reader, and the tools that carried a note
 * were believed while the tools that returned `{returned: 0}` were re-verified by hand or, worse,
 * reported as fact. Three separate testers spent calls proving a zero that was already true, and
 * one reported "this tenant has no PNG attachments" while holding 346 of them.
 *
 * The distinctions that actually matter, in order of how often they were got wrong:
 *
 * 1. **A filter zero is strong; a keyword-search zero is weak.** Filter and sort fields are
 *    checked against the object before the request, so an empty filtered result is a fact about
 *    the data. Keyword search reads only what Ivanti indexes, which is neither every field nor —
 *    on a service request — only the record's own fields.
 * 2. **A scoped zero is about one person**, not about the tenant.
 * 3. **A gated zero is about this deployment**, not about Ivanti.
 * 4. **An impersonated zero is Ivanti's answer for that person**, and is the weakest of all: the
 *    other three are narrowings this server applied and can describe, while this one is the
 *    tenant's own access control, which hides the existence of a record rather than filtering a
 *    known set. Measured: the same unfiltered query answered 571 under one role and 1 under
 *    another, seconds apart, in one conversation.
 *
 * Kept out of the tool descriptions deliberately: this is response-side, so it costs nothing on
 * `tools/list` and cannot be truncated away by a client.
 */
export interface ZeroContext {
  /** What was being looked for, as a noun phrase: "incidents", "quick actions on incident". */
  looked: string;
  /** The keyword term, when one was used. Its presence is what makes the zero weak. */
  keyword?: string | undefined;
  /** The person the answer was narrowed to, when it was. */
  scopedTo?: string | undefined;
  /** The objects this deployment allows, when a gate narrowed the answer. */
  gated?: readonly string[] | undefined;
  /**
   * The person Ivanti is applying access for, when the conversation is impersonating.
   *
   * Separate from `scopedTo` because the two are different claims: that one is a filter this
   * server composed and can explain, this one is the tenant deciding what may be seen at all.
   */
  impersonating?: string | undefined;
  /** Extra sentence for whatever is specific to this tool. */
  because?: string | undefined;
}

export function zeroNote(context: ZeroContext): string {
  const parts: string[] = [];

  if (context.keyword !== undefined && context.keyword !== '') {
    parts.push(
      `No ${context.looked} matched the keyword '${context.keyword}'. THIS IS THE WEAK KIND OF ` +
        'ZERO: keyword search reads only the text Ivanti indexes, which is not every field — a ' +
        'value held in a category, a chassis type or a filename does not match here even when it ' +
        'is exactly the word searched. Measured: `png` finds NONE of this tenant’s several hundred ' +
        'PNG attachments. Re-ask with an `eq` filter on the field you actually mean before ' +
        'reporting ' +
        'that none exist.',
    );
  } else {
    parts.push(
      `No ${context.looked}. THIS IS A REAL ZERO: the field and sort names were checked against ` +
        'the object before the request, and a wrong one is refused by name rather than answered ' +
        'with an empty list. It is a fact about the data, not a typo.',
    );
  }

  if (context.scopedTo !== undefined) {
    parts.push(
      `It is also narrowed to ${context.scopedTo}: a record belonging to someone else answers ` +
        'zero here too, so say you cannot see one rather than that none exists.',
    );
  }

  if (context.impersonating !== undefined) {
    parts.push(
      `AND THIS IS NOT THE STRONG KIND OF ZERO AFTER ALL: Ivanti answered it as ` +
        `${context.impersonating}, applying their own access. A record they may not see is ` +
        'absent here exactly as though it did not exist. Say that nothing is visible to them ' +
        'rather than that nothing exists, and do not report it as a fact about the tenant.',
    );
  }

  if (context.gated !== undefined && context.gated.length > 0) {
    parts.push(
      `And this deployment exposes only ${context.gated.join(', ')} — anything outside that was ` +
        'not looked at, so this is a statement about the deployment as much as about Ivanti.',
    );
  }

  if (context.because !== undefined) parts.push(context.because);

  return parts.join(' ');
}
