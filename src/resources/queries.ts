export const QUERIES = `
# Reading records: what Ivanti's OData actually supports

Ivanti answers OData URLs, but it implements a narrow subset and it **fails silently** rather than
refusing. Most of what follows is about telling a real answer from a confident wrong one.

## \`$filter\` has operators and no functions

Supported: \`eq ne gt ge lt le\`, \`and\`, \`or\`, and parentheses. That is the whole list.

\`contains()\`, \`startswith()\`, \`endswith()\`, \`year()\` and friends are **silently ignored** —
Ivanti drops the clause and returns the **full unfiltered set**, which looks exactly like a
successful query with a lot of matches. These are refused before the request is sent rather than
being allowed to mislead you. Use \`search\` for substrings.

    Owner eq '$NULL'                 the only way to match an empty field — TEXT FIELDS ONLY.
                                     On a date or numeric field Ivanti answers 400 "No such
                                     entry exists", which reads as a bad field NAME; the field
                                     is fine, the operator is not, and there is no null test
                                     for those types. \`ne '$NULL'\` also counts the empty
                                     string as present (13 of 42 rows, measured), so pair it
                                     with \`and Owner ne ''\` to exclude both.
    CreatedDateTime gt 2026-01-01    dates are bare and unquoted
    (A eq 1 or B eq 2) and C eq 3    parentheses work, and precedence needs them

There is **no default order**. "The latest" requires \`orderBy\`.

## \`search\` is the only substring match, and it over-matches

It is a keyword search across the record's text fields. It reaches inside words: searching
employees for \`John\` returns John Smith, John Davis, John M Doe — **and Scott Johnson**. Filter
the result yourself if you meant one of them specifically.

## There is no projection, and no expansion

Neither \`$select\` nor \`$expand\` is sent, because neither works the way it reads:

- \`$select\` on a single-record GET returns \`@odata.context\` and nothing else, and it blanks the
  values on a saved search.
- \`$expand\` is silently ignored under API-key authentication, so a caller would read "no related
  records" from a request that never happened. Use \`get_related_records\`.

Field selection therefore happens after the rows arrive. \`fields\` narrows what you are shown,
not what Ivanti sent.

## Rows default to a compact field set

A full Ivanti record carries roughly 180 fields, and a default page of 25 measured **187,278
characters**. So row-returning tools answer with a small identifying set unless you name fields or
pass \`"*"\`, and they tell you which they did. Ask for \`"*"\` deliberately, on few rows.

## Three ways to say "no rows", and only one is a list

- a normal empty array
- **200 with a completely empty body** — what an entity set answers when a filter matches nothing
- **\`{"value": "No instances found."}\`** — a *string* where the array should be, which cheerfully
  reports a length of 19

All three are normalised to no rows. Prose in \`value\` that is not recognised is treated as an
error rather than as an empty result.

## Keyword search covers indexed fields, not every field

\`search\` reaches what Ivanti indexes for keyword search — a ticket's subject, description and
notes. It does **not** reach every text field, and on some objects it reaches very little.
Measured: \`png\` finds none of this tenant's **344 PNG attachments**, and \`laptop\` finds
neither computer whose \`ChassisType\` is literally "Laptop".

So an empty keyword result means *"not in the indexed text"*, never *"no such record"*. Before
telling anyone there are none, retry with \`list_records\` and an \`eq\` filter on the field you
actually mean. The two questions look identical from the outside and are answered by different
mechanisms.

## A grouped count can be a partial picture

Grouping a field takes its buckets from that field's validation list — the values a **create
form** offers — and records can hold values the list no longer offers. Measured: a change's
statuses bucketed to 12 of 51 records, and an incident's categories to 81 of 547, with every
bucket correctly flagged \`exact: true\`. The counts were right; the set of buckets was short.

An answer of that shape reports \`total\` and \`unaccounted\` for exactly this reason. A non-zero
\`unaccounted\` means it is not a breakdown of the whole and must not be presented as one.

## Counts are a floor, not always a total

\`@odata.count\` sometimes tracks the page rather than the match, and can report 0 alongside real
rows. Answers therefore carry \`totalIsExact\`. When it is false, the number is a lower bound.

## There is no 404

A get-by-key for a record that does not exist answers **400 ISM_4000 "Invalid key"** — the same
status and the same code as a malformed field name. "Not found" and "you typed the field name
wrong" are indistinguishable from the status alone.

**Zero rows means the records do not exist.** After \`IncidentNumber eq 11150\` returns nothing, do
not go hunting through neighbouring numbers: it is an answer, not a near miss.

## Never read success from a 200

Ivanti's characteristic failure is answering OK and doing something else. Every write here is read
back before it is reported as done, and every degraded read says how it was degraded. Treat a bare
200 from any surface the same way.
`.trim();
