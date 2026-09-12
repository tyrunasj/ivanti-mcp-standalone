export const FIELD_NAMES = `
# A field has three names, and they are per object

Ivanti stores a field under a technical name, labels it with a display name, and lets each *form*
relabel it again for the people who use that form. The three routinely differ, and which one you
are looking at depends on where you read it.

| Layer | Example on an incident | Where it appears |
|---|---|---|
| Form label | "Customer" | the screen a person actually uses |
| Display name | "Profile Link" | the object's own metadata |
| Technical name | \`ProfileLink_RecID\` | what a filter or a write must send |

Resolution order is **form label, then display name, then technical name** — the tools answer with
the most human of the three that exists, and can translate any of them back.

## Never carry one object's names to another

This is the mistake that looks most like knowledge. Measured on a live tenant:

| Object | The customer field |
|---|---|
| Incident | \`ProfileLink_RecID\`, labelled **Customer** |
| ServiceReq | \`ProfileLink_RecID\`, labelled **Contact Link** |
| Change | no \`ProfileLink\` at all — it is \`RequestorLink_RecID\` |
| FRS_Knowledge | no person link of any kind |

An incident's description is \`Symptom\`; its summary is \`Subject\`. Those are facts about
*incidents on this tenant*, not about Ivanti. Call \`get_object_metadata\` for the object in front
of you — it is cached, so asking twice in a conversation costs nothing — and read the names off
the answer rather than carrying them between objects.

## Link fields travel in pairs

A field ending \`_RecID\` is a foreign key, not a picklist. It takes the target record's RecId and
it has a \`_Category\` sibling naming which object that record lives in. **Both halves must be
written.** A RecId alone leaves the record pointing at something of unstated type, which the UI
renders as empty.

Note the spelling difference between the layers: \`$metadata\` reports objects lowercase
(\`employee\`) while records store the category mixed-case (\`Employee\`). Write what the records
use.

## Reading Ivanti's refusals

Ivanti writes its errors in the display language, not the technical one, so a message rarely names
the field you have to change.

- **"Required field Incident.Description value must be provided"** — \`Description\` is a display
  name; the field is \`Symptom\`. The tools translate this through the form and answer with the
  name to send, so read the refusal rather than looking it up again. Ivanti names several fields
  at once, so expect more than one.
- **A required-field message sometimes names a link rather than a field.** "Incident.Customer" is
  \`ProfileLink_RecID\` **plus** \`ProfileLink_Category\`, and supplying one half returns the same
  refusal.
- **"'<value>' is not in the validation list of validated field <object>.<field>"** — a picklist
  rejection. See \`ivanti://reference/picklists\`.
- **A 400 naming a value you never sent** means Ivanti auto-filled that field and then rejected
  its own default. Owner is the usual one: it defaults to the account this server signs in as.
  Set it explicitly.

Required-field rules are **conditional**. An incident can be created with almost nothing and sit
at \`Logged\`; moving it to \`Active\` requires Category and Owner, and \`Resolved\` requires more
again. A create that succeeded yesterday can be refused today because the status differs.
`.trim();
