// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

export const WRITE_RECIPES = `
# Writing to Ivanti: the parts that are not guessable

## Creating a child under a parent

Set **both** \`ParentLink_RecID\` (the parent's RecId) and \`ParentLink_Category\` (the parent's
object) in the same \`create_record\` call. The Contains relationship —
\`IncidentContainsTask\`, \`IncidentContainsJournal\` — is wired by that one call.

## Adding a note

A note is not an operation, it is a record in \`Journals\`. What is not guessable is its shape:

    create_record({ object: 'Journals', fields: {
      Subject: 'Called the customer — archive job re-enabled.',
      JournalType: 'Notes',
      ParentLink_RecID: '<the incident RecId>',
      ParentLink_Category: 'Incident',
    }})

- The note text goes in \`Subject\`. There is no \`Details\` field, and sending one is a 400.
- \`JournalType\` must be set; \`Notes\` is the human-written kind.
- Reading them back, **filter by type**: Ivanti writes its own Email journals into the same
  relationship and they usually outnumber the real notes.

## Required fields the schema does not flag

Some objects refuse a create over fields whose metadata says \`nullable: true\`, and no API lists
them. Read the 400: it names them, and the refusal resolves each display name to the field to set.

Known on \`Task\`: \`TaskType\` reports \`nullable: true\` and a create without it is refused
(\`Required field Task.TaskType\`).

## Omitting a validated field is not skipping it

Ivanti may auto-fill one and then reject its own value, so supply validated fields explicitly.
Write the plain value, never its \`_Valid\` twin: the value and its option identifier are stored as
a pair, and a value written without the identifier can be accepted and stored as nothing. A value
that is not allowed under the parents being written is refused **before** anything is written, with
the list of what is allowed. See \`ivanti://reference/picklists\`.

## Attaching a file

\`upload_attachment\` takes the file as base64 and does the two halves Ivanti splits: it stores the
bytes, then sets the \`ParentLink\` pair that makes the file belong to the record. The upload alone
leaves it belonging to nothing.

The parent is checked **before** the bytes are sent, because Ivanti accepts an upload against a
record that does not exist and the resulting file is reachable from nothing. Removing a file is
\`delete_attachment\` — there is no detach that keeps it.

## Every write is read back

A write is not reported as done until the record has been re-read and the values checked. Ivanti's
characteristic failure is answering 200 over a record that did not change, so a tool that said
"stored" here means it looked.

## Incident lifecycle

Required fields are conditional: an incident reaches \`Logged\` with almost nothing, \`Active\`
needs Category, Owner and Team, and \`Resolved\` additionally needs CauseCode, Resolution,
Description and Customer. A create that succeeded yesterday can be refused today because the status differs.

Collect the fields before trying — \`IncidentNumber\` is allocated before validation, so a refused
create still consumes one and the numbers are not contiguous.

Priority may be recalculated from Urgency and Impact, so a Priority you send can differ from the
one stored. Read it back rather than assuming.

## The customer is not the assignee

They are different fields and they answer different questions. The link pair — \`ProfileLink_RecID\`
plus \`ProfileLink_Category\` on an incident here, labelled "Customer" — says who the record is
FOR. The assignment says who will work it, and **nothing you send decides it**: Ivanti fills it
from the SIGNED-IN SESSION.

Where this server signs in AS the person (impersonation), a record raised for someone therefore
comes back assigned to that same person, in that person's own team — so it sits in nobody's queue
and no analyst sees it. Measured on this tenant, acting as one employee: a create carrying no
assignment stored \`Owner\` as that employee and \`OwnerTeam\` as their team, and advanced the
record to \`Active\`. The identical create without impersonation stored the service account.

Two things follow:

- **Supply the status the tenant starts records in** and the assignment is left empty — measured,
  the same create then stored \`Owner\` as null and stayed at that status. This is the shape a
  queue can pick up.
- **The assignment cannot be cleared afterwards while the record sits at a status that requires
  it.** Ivanti answers \`requires Owner\`, so "create now, unassign later" does not work. Decide
  at create time.

Authorship is the opposite case and needs no action: \`CreatedBy\` naming the person is exactly
what acting for someone is for. The create's confirmation lists every field Ivanti stamped with
them, so the two can be told apart on the record rather than guessed at.
`.trim();
