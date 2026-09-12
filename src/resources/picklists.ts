export const PICKLISTS = `
# Validated fields, and the cascades that filter them

A **validated** field is a picklist: its allowed values live in a separate Business Object rather
than in the record. Ivanti keeps a pointer to the chosen option in a \`_Valid\` twin
(\`Status_Valid\`).

**Never write a twin.** Write the display field — \`Status: 'Active'\` — and the value plus its
option identifier are resolved and stored as the pair Ivanti expects. A value written without its
identifier can be accepted and stored as nothing.

## The form is the authority, not the schema

\`$metadata\` says whether a field *is* validated and then stops: it carries no values, and it is
not even reliable about which fields are validated. Measured: \`Task\`'s CSDL reports **zero**
validated fields while its create form declares **twenty**. The allowed values exist only on a
create form, which is why \`get_pick_list_values\` needs an Ivanti session and \`$metadata\` alone
cannot answer.

## Cascades

Some validated fields are filtered by what sibling fields hold on the same record.
\`get_pick_list_constraints\` reports it as \`constrainedBy\`. Measured on a live tenant, 4 of an
incident's 21 validated fields are filtered:

    Category     <- Service
    Subcategory  <- Service, Category
    Owner        <- OwnerTeam

An empty \`constrainedBy\` means any value from the source object is fine. A non-empty one means
the value has to be legal **under the parents you are also writing** — a value that is valid in
isolation is still refused under the wrong parent, and that is the most common validated-write
failure.

## The unfiltered list is a subset, not the union

Asking a cascading field for its values **without** its parents does not give you everything — it
gives the list for the form's default parent, which is usually a small fraction. Measured on one
incident's \`Category\`: **5** values unfiltered, **13** under a single Service, and **69** rows in
the backing object. A caller who reports the unfiltered answer as "the categories" is out by more
than an order of magnitude.

To enumerate everything a field could ever hold, read its backing object directly —
\`list_business_objects\` with \`includeValidationLists\`, then \`list_records\` on what it names.

## \`validated\` is a floor, not a ceiling

\`get_object_metadata\` reports \`validated\` from \`$metadata\`, and a field **without** the flag
may still be backed by a list the form knows about — \`Employee.Department\` carries no flag and
has 17 values. If a field looks enumerable, ask for its values regardless of the flag rather than
paging the table to find out.

## Searching a long option list

\`get_service_request_parameter_options\` takes a \`search\`, and it matches the **start of the
label**, case-insensitively. Not a substring, and never the value: \`Bob\` finds "Bob M Levitt",
while \`Levitt\` finds nothing — and so does \`BLevitt\`, which is the value you would have to
submit. Search by the first word, or omit it and read the whole list.

## Two traps

**Do not infer a cascade by sampling records.** Real data covers a fraction of the valid pairs, so
"no incident has that Category under that Service" is not evidence the pair is invalid.

**Asking for a cascaded field without its parents does not give you the whole list.** It gives the
options available when the parent is *empty*, which is usually neither the full set nor a superset
of any real parent's list. \`get_pick_list_values\` reports which parents apply
(\`constrainedBy\`), which ones your call actually used (\`filteredBy\`), and says so when they
differ. A parent passed under a name the form does not have filters nothing, and that is reported
rather than swallowed.

## Getting the values

    get_pick_list_values({ object: 'Incident#', fields: ['Category'],
                           values: { Service: 'Email Service' } })

One call, filtered by Ivanti itself — the same evaluation the form UI does. A refused write also
answers with the allowed list, so a rejection is usually enough to retry correctly without asking
again.

## A link field is not a picklist

A field ending \`_RecID\` is a foreign key: it takes the target record's RecId, and it travels as
a pair with its \`_Category\` sibling. \`get_link_fields\` lists an object's links with the label
each one carries on that object — which is not the same label on the next object. See
\`ivanti://reference/field-names\`.
`.trim();
