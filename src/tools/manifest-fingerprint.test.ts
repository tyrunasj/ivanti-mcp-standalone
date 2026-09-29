// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fingerprintManifest } from './manifest-fingerprint.js';
import type { ToolDefinition } from './tool-definition.js';

const tool = (description: string, argument = 'The record.'): ToolDefinition => ({
  name: 'get_record',
  config: {
    title: 'Get record',
    description,
    inputSchema: z.object({ recordId: z.string().describe(argument) }).strict(),
    annotations: {},
  },
  handler: () => ({ content: [] }),
});

describe('fingerprintManifest', () => {
  it('is the same for the same text, so two processes of one version group together', () => {
    expect(fingerprintManifest([tool('Reads one.')], 'Be careful.')).toEqual(
      fingerprintManifest([tool('Reads one.')], 'Be careful.'),
    );
  });

  it('moves when a description, an argument or the instructions move', () => {
    const base = fingerprintManifest([tool('Reads one.')], 'Be careful.').manifest;

    expect(fingerprintManifest([tool('Reads one record.')], 'Be careful.').manifest).not.toBe(base);
    expect(fingerprintManifest([tool('Reads one.', 'Its RecId.')], 'Be careful.').manifest).not.toBe(base);
    expect(fingerprintManifest([tool('Reads one.')], 'Be very careful.').manifest).not.toBe(base);
  });

  it('measures what a model is handed, schema included', () => {
    const { manifestChars } = fingerprintManifest([tool('Reads one.')], 'Be careful.');

    // More than the description and instructions alone: the argument schema is sent too.
    expect(manifestChars).toBeGreaterThan('Reads one.'.length + 'Be careful.'.length + 'The record.'.length);
  });
});
