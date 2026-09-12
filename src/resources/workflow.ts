export const WORKFLOW = `
# Running the tenant's own procedures, and relating records

## Prefer a quick action to a raw write

For anything Ivanti has defined — Close, Resolve, Escalate, Clone — use \`list_quick_actions\` then
\`run_quick_action\`. The action runs its own configured logic: the child records it creates, the
approvals it starts, the values it fills in.

A raw field update does not bypass the tenant's business rules — those still fire on a field
change — but it does skip the action's own logic, which is usually the part that was wanted.

- \`preview_quick_action\` runs nothing and reports what the action will ask for. Actions that
  prompt (Close Incident and friends) need those values passed to \`run_quick_action\`.
- \`run_quick_action\` **repeats its side effects on retry**. It is the one tool here that is both
  destructive and non-idempotent.
- Ivanti's reply carries a \`saved\` flag that is **not trustworthy**: a rejected action can report
  \`saved: true\` over a record that did not change. The real failure is in the per-field
  validation messages, which name the field. Believe the tool's error, not a flag inside it.
- \`UIAction\` actions are client-side only. They change nothing and answer OK, so they are refused
  rather than reported as success.

## Approvals

The object is \`frs_approval#\` (\`frs_approvals\`); "Approvals" is not a name Ivanti knows.

- Pending: \`list_records({ object: 'frs_approvals', filter: "Status eq 'Pending'" })\`. \`Name\`
  describes the step and \`ParentLink_Category\` says what is waiting.
- **Voting is a quick action, not a field update** — "Approve My Vote" / "Deny My Vote". Setting
  Status directly skips the workflow that acts on the result.
- **"My Vote" means the account this server signs in as**, not the person you are talking to.
  Casting one records the service account's decision. Confirm with the user first, and never
  present a pending-approval list as theirs.

## Saved searches answer for the service account too

A saved search called "My …" was written by, and resolves for, the signed-in account.
\`list_saved_searches\` flags the ones that do. Do not present those results as anyone else's.

## Linking, and the one that does damage

\`link_records\` attaches records that already exist; a child created with the ParentLink pair is
already attached and needs neither.

\`unlink_records\` is the dangerous one. Ivanti accepts an unlink of something that was never
linked, and on a Contains relationship it severs the target from whichever record **is** its
parent — damage to a third record that nothing in the reply mentions. The link is therefore
checked first and such an unlink is refused. Confirm with \`get_related_records\` before unlinking.

## Attachments are not linked, they are owned

An attachment's relationship to its ticket **is** \`ParentLink_RecID\` + \`ParentLink_Category\` on
the attachment row — \`IncidentContainsAttachment\` is a view over those two fields. So
\`unlink_records\` on an attachment does not detach it, it **orphans** it: measured live, both
halves go null, the row survives, and the file is left on no ticket, matched by no ownership check
and reachable by nobody. Removing a file means \`delete_attachment\`, not unlinking it; adding one
is \`upload_attachment\`, which sets the pair itself.

## Finding who has an approval waiting

\`list_approvals\` answers forwards, from a login you already have. To go the other way, read the
vote rows directly:

    list_records({ object: "frs_approvalvotetracking",
                   filter: "Status ne 'Approved'",
                   fields: "Owner,OwnerFullName,OwnerEmail,Owner_Valid,DueDateTime" })

**Do not group those rows by \`Owner\` alone.** It holds a login on most rows and a display name on
others — measured, one tenant carried both \`BSmith\` and \`Becky   Smith\` (three spaces) for the
same person, so grouping by \`Owner\` reported ten approvers where there were nine and undercounted
one queue by a quarter. \`Owner_Valid\` is the employee RecId and is the only identifier that never
varies; \`OwnerEmail\` is the next best. Better still, feed each candidate login back through
\`list_approvals\`, which reconciles all three itself.

Two further traps:

- **Filter on \`Status ne 'Approved'\` rather than \`eq 'Pending'\`.** The vote vocabulary is the
  tenant's own; a tenant that spells the undecided state differently answers zero to \`'Pending'\`
  and the zero looks like an empty queue.
- **An approval BLOCK (\`frs_approval\`) can be Pending with no vote rows on it at all** — nobody
  was asked. Such a block is invisible to every per-person query. Find them with
  \`list_records({ object: "frs_approval", filter: "Status eq 'Pending'" })\`, whose \`Owner\` is the
  block's owner and **not** an approver. Note the two objects' RecIds look identical (32 hex) and
  \`vote_on_approval\` takes the VOTE ROW's id, never the block's.

## Previewing a delete

\`preview_delete\` reports what would go with a record. Read \`errorMessages\` for blockers:
Ivanti answers \`status: 'error'\` for a clean preview that carries only warnings, so the status
alone says nothing.
`.trim();
