# Measuring what the instructions cost

How to find out what the server's text — tool descriptions, argument schemas, the server
`instructions`, the reference documents — costs the conversations that use it, and how to tell
whether a change to that text made things better. For how the pieces are built, see
[`architecture.md`](./architecture.md#logging); for the commands in passing,
[`development.md`](./development.md).

## Two costs, and why the second is bigger

**Direct cost — the text itself.** The manifest (every tool's name, description and argument
schema) and the `instructions` are sent with **every request** of every conversation: each turn,
and each step of a tool loop. A client with prompt caching pays less for the repeats; it still
pays.

**Indirect cost — what the text makes the model do.** A description that misleads, leaves out a
warning or overlaps with another tool's shows up as calls: refused ones, empty ones asked again
differently, identical ones repeated, a hop to another tool. Each wasted call is a whole extra
request — the manifest and everything before it, re-sent — and its own result then rides along on
every request after it. An early mistake is dearer than a late one.

So the figure worth optimising is **context per completed conversation**, not the size of the
manifest. A sentence that prevents one retry pays for itself many times over; a sentence that
makes every conversation do one extra lookup may cost more than it saves.

**Everything here is measured in characters, not tokens.** The server is vendor-agnostic and
every model family tokenizes differently: a count exact for one is wrong for the next.
Characters are what the server controls, need no credential, and come out the same every run.
Relative questions — which tool is dearest, did this edit help — have the same answer in any unit.
The caveat: JSON, schemas and 32-character hex ids pack fewer characters into a token than prose,
so across very different kinds of text a character count is slightly kind to the dense ones.
`usage:report --chars-per-token N` converts at a ratio you supply for one model family, and labels
the result an estimate.

## The pieces

| | What it answers | Where it runs |
|---|---|---|
| `pnpm manifest:size` | What every request carries: per deployment, per tool, per document | Locally, and on every pull request in CI |
| `tool finished` / `resource read` log lines | What each call put into the conversation, and how it ended | The running server, at `LOG_LEVEL=info` |
| `pnpm usage:report` | Per tool, the waste and its patterns, and version against version | Locally, over collected logs |

## 1. The direct cost — `pnpm manifest:size`

```bash
pnpm manifest:size                               # the whole account
pnpm manifest:size --json > /tmp/before.json     # a snapshot, before an edit …
pnpm manifest:size --compare /tmp/before.json    # … and after it: only what moved
```

It builds `tools/list` the way a client receives it — over an in-memory transport, so the SDK's
schema conversion is included — for every mode × tier × impersonation, because descriptions vary
on all three. It prints:

- **each deployment**: tool count, manifest, instructions, and their sum per request;
- **each tool**, in the dearest deployment, split into description and name + schema. The schema
  half — argument names, types, enums and argument descriptions — is about as large as the
  descriptions, and the character caps in `description-budget.test.ts` do not see it;
- **each reference document**, paid only when a conversation reads it.

**On every pull request, CI runs it against the base branch** and writes a table to the run's
summary (Actions → the run → Summary), plus a one-line annotation on the PR — for example
`Manifest + instructions: 72,749 → 73,169 characters per request (+420, full/session/plain)`.
It informs; it never blocks a merge. The caps in the budget test are what fail.

**Not counted:** the client's own system prompt and tools, and the `mcp__<server>__` prefix some
clients put in front of tool names. `title` and `annotations` are left out on purpose — they steer
the client, not the model.

**A vendor's tokenizer can plug in.** `Counter` in `scripts/lib/manifest-size.ts` takes a whole
request and returns a number; every figure is already a difference against an empty probe tool,
so a counter that also prices a vendor's tool-use preamble works unchanged. Use one only for a
deployment known to serve one model family.

## 2. The runtime record — the usage lines

The server writes these at **`info`** (the default). They carry **sizes and markers only, never
content** — no arguments, no ticket text, no names.

### `tool finished` — one per tool call

| Field | Meaning |
|---|---|
| `tool` | The tool called. |
| `outcome` | `ok`; the refusal's class (`UnsupportedFilterError`, `FieldNameError`, `IdentityRequiredError`…); `ivanti <status>`; `SessionRenewed` (the person's Ivanti session had ended and was re-opened, but the write was not repeated) or `SessionUnavailable` (it could not be re-opened); `error` (the tool answered with an error of its own); `discarded` (the conversation ended mid-call); or `fault` (a bug here). |
| `argsChars` | Size of the arguments as the model wrote them — output the model paid to generate. |
| `argsHash` | Equal for equal arguments, in any key order, within one process. Salted per process and never reversible from the log; it exists only to spot an identical call made twice. |
| `resultChars` | Size of the text the model reads back. `nonTextChars` when an image or other block came too. |
| `rowsRead` | Rows read from Ivanti collections during the call, summed. `0` is an empty answer. Absent when the call read no collection — a record fetch, a create or update. A write that checks or reads back a row by filter (`add_note`, `link_records`, `vote_on_approval`) counts it. |
| `ivantiRequests` | Requests made to Ivanti — latency and tenant load, not model tokens. |
| `ms` | How long the call took. |
| `conversation` | A random id per conversation, unique across sessions and processes. A new one begins when the client initializes again or the conversation goes idle. |
| `sessionId` | The HTTP session. Absent under stdio. |
| `client` | The client's own `name/version` from `initialize` — the nearest a server gets to knowing the model. |
| `manifest` / `manifestChars` | A fingerprint of the tools and instructions in force, and their size per request. Changes when any description, argument or the instructions change, and only then. |
| `rpcId` | The JSON-RPC request id, which also appears on the debug lines the call caused. |

### `resource read` — one per reference document read

`uri` and `resultChars`, plus `outcome: IdentityRequiredError` when it was withheld because nobody
had been named with `act_as` yet.

### The startup line

`listening on stdio` / `listening on http` carries `manifest` and `manifestChars` too, so a log
says which version of the text a process was serving from its first line.

## 3. Collecting the lines

Logs go to **stderr** — stdout is the JSON-RPC stream under stdio. Keep `LOG_LEVEL` at `info` or
`debug`.

```bash
kubectl logs deploy/<release> --since=168h > usage.log     # the Helm chart
docker logs <container> > usage.log 2>&1                    # a container: stderr, hence 2>&1
```

Under **stdio** the client owns the process and its stderr. To keep a copy, wrap the command in
the client's configuration so stderr is appended to a file:

```json
{ "command": "sh", "args": ["-c", "exec node /path/to/dist/index.js 2>>\"$HOME/ivanti-usage.log\""] }
```

A collector's prefix in front of each line (`2026-09-29T10:00:00Z stdout F {…}`) is fine — the
report reads from the first brace. So is a log that interleaves many sessions and processes: every
line carries its `conversation`.

## 4. Reading it — `pnpm usage:report`

```bash
pnpm usage:report usage.log
kubectl logs deploy/<release> | pnpm usage:report          # from stdin
pnpm usage:report usage.log --chars-per-token 3.5          # a rough token figure, one model family
pnpm usage:report usage.log --json                         # everything, for a dashboard or a diff
```

The report has these sections, in this order.

**Waste.** Calls in any of three patterns, counted once each, with the share of all context they
account for:

| Pattern | What it is | What it usually implicates |
|---|---|---|
| failed | any `outcome` but `ok` | the description that should have warned; for `ivanti <status>`, often a value the model guessed |
| empty, then asked again differently | `rowsRead: 0`, then the same tool with other arguments | search guidance — keywords against filters, which tool searches what |
| identical call repeated | the same tool with the same `argsHash`, earlier in the conversation | the model did not trust or lost the result — often because it was too large |

Two more counts sit under it: **the same refusal twice in a row**, and **conversations that ended
on a failure** — the model gave up, or the person did.

*Context cost.* A call's cost is `manifest + everything before it + (its arguments + result) × the
requests after it`: the request that produced it, and its own text re-sent until the conversation
ends. The conversation's total is every request's manifest plus everything before it. Neither
counts model output beyond the arguments, nor prompt-caching discounts — so the absolute figures
overstate a bill, and comparisons between two versions stay fair.

**After each refusal.** For every refusal class: how often it was seen, how often the *next* call
succeeded, and how often the same refusal came straight back. A refusal message is an instruction
too — the cheapest kind, paid only when the mistake happens and read at the moment the model is
confused. A class with a low recovery rate has a message that does not say what to do instead.

**Switched tool after a failure or an empty answer.** Transitions like `search → fulltext_search_object`.
A frequent one names two descriptions a model cannot tell apart. Moving to `act_as` after an
identity refusal is the gate working, and is left out.

**Lookups before the first answer.** Calls to `list_business_objects`, `get_object_metadata`,
`get_link_fields` and the pick-list tools before the first call that succeeded at something else.
Some are needed; a p95 that keeps climbing means the naming guidance is not landing — or that an
instruction is sending the model to look things up it does not need.

**Per tool, dearest first.** Calls, failures, retries, result size (p50, p95, max, total),
argument size, Ivanti requests per call and p95 latency. A large result early in a conversation is
paid on every later request; this is where trimming results shows up.

**How calls failed, per tool**, then **reference documents read** — a document nobody reads is a
line in the `instructions` that costs every request and buys nothing; one read in every
conversation might belong in a description instead.

**By version of the instructions and client.** Conversations, calls per conversation, the share of
calls that failed, and the share of context that was waste — grouped by `manifest` and `client`.
**This is the table a change is judged by.**

## 5. The tuning loop

1. **Baseline.** Collect a representative stretch of logs — a week of real use — and run the
   report. Note the `manifest` fingerprint it is all under.
2. **Pick one thing,** from the top of the report: the refusal with the worst recovery rate, the
   switch that recurs, the tool with the largest results, the document nobody reads, the dearest
   description in `manifest:size`.
3. **Change that one thing.** Prefer, in order: making a refusal message say what to do (paid only
   on the mistake), trimming a result, sharpening the description that failed to warn, and only
   then adding text every request pays for.
4. **Check the direct cost:** `pnpm manifest:size --compare` locally; the PR summary shows it too.
5. **Ship, deploy, then check the behaviour on the live tenant** through `ivanti-http`, the k3s
   deployment: drive the case that was failing, then run the report over that session's log. To
   check before shipping, run a local server instead
   ([`development.md`](./development.md#testing-against-the-live-tenant)).
6. **Collect again.** The report's version table now has two rows — before and after — with the
   same client.
7. **Keep it or revert it** on the waste share and the failed share, not on the manifest size. Write
   down *what* changed and *why* in [`notes.md`](./notes.md); leave the figures out — they go stale.

Change one thing per version. Two changes under one fingerprint cannot be told apart.

## Reading the numbers honestly

- **Clients differ.** Different clients run different models, and models make different mistakes.
  Compare versions within one client, never across.
- **A result's format can change between versions.** 0.2.5 made every result compact JSON and
  turned `get_object_metadata`'s fields into rows, so `resultChars` fell for the same answer.
  Compare result sizes within a `manifest`, and use the waste and failed shares across them.
- **A small sample lies.** A handful of conversations says little about a refusal rate; the version
  table prints the conversation count for that reason.
- **`rowsRead` is a sum.** A call that looked someone up before running its query counts both —
  `list_assigned_work` does — so a non-zero figure is not always a non-empty answer.
- **`argsHash` is per process.** An identical call in another process — another stdio client,
  a restarted server — hashes differently. Repeats are only detected within a conversation, which
  never spans processes.
- **A live log has unfinished conversations.** One whose last call failed may simply not have
  continued yet; "ended on a failure" is firm only for a log collected after the fact.
- **The waste patterns are proxies.** A second, different `list_records` after an empty one is
  usually a rephrasing and occasionally a genuinely new question.

## What the server cannot see

Turns where the model only thought, or asked the person something it did not need to; text it
wrote beyond its arguments; and whether its final answer was right. Those need the conversation
itself: a benchmark — fixed tasks, run on a few models from different vendors, with graded answers
and each vendor's own token counts — is the instrument for them. Build its task list from the
patterns this report finds most often, so every change to the text is tested against the mistakes
models actually make.
