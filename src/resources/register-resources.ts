// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config/env-schema.js';
import type { ToolContext } from '../tools/register-tools.js';
import { ENTITY_NAMING } from './entity-naming.js';
import { FIELD_NAMES } from './field-names.js';
import { PICKLISTS } from './picklists.js';
import { QUERIES } from './queries.js';
import { WORKFLOW } from './workflow.js';
import { WRITE_RECIPES } from './write-recipes.js';

/**
 * Reference material, served as MCP resources rather than as tool descriptions.
 *
 * These are stable Ivanti facts, not per-call guidance, and the alternative is paying for them in
 * every conversation: a tool description is sent on every `tools/list`, and `instructions` on
 * every session. A resource costs nothing until something asks for it.
 *
 * **What must NOT move here.** A resource is a pull, and plenty of clients never pull one. So
 * anything whose absence would *mislead* stays in the tool description that needs it — that
 * `$filter` functions are silently dropped, that zero rows means zero records, that a compact
 * field set was returned. The rule is: descriptions carry what is dangerous not to know, and
 * resources carry what is expensive to repeat.
 *
 * Narrowing matches the tools, for the same reason it does there: a document that tells the model
 * to call something this deployment does not register is worse than no document.
 */
export interface ResourceDefinition {
  name: string;
  uri: string;
  title: string;
  description: string;
  text: string;
}

const URI_PREFIX = 'ivanti://reference/';

function reference(
  name: string,
  title: string,
  description: string,
  text: string,
): ResourceDefinition {
  return { name, uri: `${URI_PREFIX}${name}`, title, description, text };
}

export function selectResources(config: Config, context: ToolContext): ResourceDefinition[] {
  // Without a tenant there are no Ivanti tools, so there is nothing for the reference to refer to.
  if (context.ivanti === undefined) return [];

  const session = context.ivanti.capability.tier !== 'odata';

  const resources = [
    reference(
      'entity-naming',
      'Naming a Business Object',
      "Ivanti's three name forms, the plural rule that is not English pluralisation, and what a wrong name does instead of erroring.",
      ENTITY_NAMING,
    ),
    reference(
      'field-names',
      'A field has three names',
      'Form label, display name and technical name — why they differ per object, and how to read the display names in Ivanti’s refusals.',
      FIELD_NAMES,
    ),
    reference(
      'queries',
      'Reading records',
      'The OData subset Ivanti really implements: no filter functions, no projection or expansion, three encodings of "no rows", and no 404.',
      QUERIES,
    ),
    reference(
      'write-recipes',
      'Writing to Ivanti',
      'Child records under a parent, notes as Journals, required fields the schema does not flag, and the conditional incident lifecycle.',
      WRITE_RECIPES,
    ),
  ];

  // The values of a validated field live on a create form, which needs an Ivanti session.
  if (session) {
    resources.push(
      reference(
        'picklists',
        'Validated fields and cascades',
        'Why the form is the authority rather than $metadata, how cascades filter a list, and the two ways of getting the allowed values wrong.',
        PICKLISTS,
      ),
    );
  }

  // Quick actions, approvals and the relationship tools are all staff surfaces.
  if (session && config.MCP_MODE === 'full') {
    resources.push(
      reference(
        'workflow',
        'Running the tenant’s procedures',
        'Quick actions over raw writes, approvals as votes, the unlink that damages a third record, and why an attachment is not linked.',
        WORKFLOW,
      ),
    );
  }

  return resources;
}

/**
 * Registers the documents on one server.
 *
 * Like the tools, the definitions are built once and shared: the text is a module-level constant,
 * so a session costs a map entry rather than a copy. Registering any resource is what makes the
 * SDK advertise the `resources` capability, so a deployment with none simply does not have it.
 */
export function registerResources(
  server: McpServer,
  resources: readonly ResourceDefinition[],
): string[] {
  for (const resource of resources) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: 'text/markdown' },
      (uri: URL) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: resource.text }],
      }),
    );
  }

  return resources.map((resource) => resource.uri);
}
