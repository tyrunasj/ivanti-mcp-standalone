/**
 * Held as a TypeScript string rather than a markdown file read at runtime.
 *
 * `dist/` would otherwise need the documents copied beside it, and this project already learned
 * what that costs: `src/version.ts` reads `package.json` at startup, and a container image that
 * forgets to copy it refuses to start. A string compiles in and cannot be left behind.
 */
export const ENTITY_NAMING = `
# Naming a Business Object

Ivanti names the same object three ways, and its own surfaces disagree about which to use.

| Form | Looks like | Where it comes from |
|---|---|---|
| AdminUI id | \`Incident#\`, \`CI#Computer\` | workspaces, forms, quick actions |
| OData entity set | \`Incidents\`, \`CI__Computers\` | the REST and OData URLs |
| CSDL singular | \`incident\` (lowercase) | \`$metadata\`, and what \`get_object_metadata\` reports as \`object\` |

**Every tool here accepts all three.** The name is resolved through the metadata catalog before
anything is sent, so \`Incident#\`, \`Incidents\` and \`incident\` are interchangeable in any
\`object\` argument. You only need the conversion rule below when you are reading a name out of
Ivanti's own output and want to know what it will become.

## The plural is not English

Take the AdminUI id, replace every \`#\` with \`__\` (or drop a trailing \`#\`), then append a
literal \`s\`:

    Incident#        -> Incidents
    Category#        -> Categorys            (not Categories)
    IncidentStatus#  -> IncidentStatuss      (not IncidentStatuses)
    CI#Computer      -> CI__Computers        (the '#' becomes '__')

The rule converts a name you already have. It does not invent one: a picklist's values usually
live in \`<Entity><Field>\`, but that is a convention and tenants break it, so find the object with
\`list_business_objects\` rather than deriving its name from the field.

The dotted form from Ivanti's own documentation (\`CI.Server\`) is not accepted anywhere.

## What a wrong name does

Nothing useful, which is why the catalog check exists.

- **An English plural returns an empty result, not an error.** \`Categories\` answers 200 with no
  rows, which reads as "there are no categories". Resolving through the catalog turns it into a
  naming error with suggestions instead.
- **An unknown entity set makes Ivanti fabricate a schema.** Ask for the \`$metadata\` of an object
  that does not exist and it answers 200 with a valid CSDL document describing an entity type with
  no fields. A parsed document with no fields is a typo, never a schema.
- **A bare singular is a 404 ISM_4004.**

## Base types cannot be created

Some objects exist only as the parent of others. \`get_object_metadata\` reports them with a
\`subtypes\` list and a note. Reading one is fine; creating one answers 500 with an empty message.
Create the subtype — \`task__assignments\`, not \`tasks\`.

Unsure of a name? \`list_business_objects({ search: '<term>' })\`. On a tenant whose credential
reaches the admin console that searches the complete catalog, which is far larger than the objects
the metadata graphs know about.
`.trim();
