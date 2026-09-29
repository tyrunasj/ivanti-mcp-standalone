// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { createDownloadAttachmentTool } from './download-attachment.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};

/** One attachment row; the file itself is served by the spy below, not the fixture. */
function tool(row: Record<string, unknown>, file?: { bytes: Uint8Array; contentType: string }) {
  const { connection, urls } = connectionFixture({
    entities: { incident: {} },
    responses: {
      attachments: {
        value: [{ RecId: 'a1', ParentLink_Category: 'Incident', ParentLink_RecID: 'i1', ...row }],
      },
    },
  });
  const fetch = vi
    .spyOn(connection.transport, 'requestBinary')
    .mockResolvedValue(file ?? { bytes: new Uint8Array(), contentType: 'text/plain' });
  return {
    urls,
    fetch,
    download: createDownloadAttachmentTool({
      connection,
      gate: OPEN_GATE,
      logger: logger(),
      ownRecordsOnly: false,
      actions: OPEN_ACTIONS,
    }),
  };
}

const ascii = (length: number): Uint8Array => new Uint8Array(length).fill(0x61);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('download_attachment', () => {
  it('refuses a file nobody can read BEFORE downloading it', async () => {
    // The type used to be learned from the reply's content type, which meant fetching a video
    // or an archive in full just to say it could not be read.
    const { download, fetch } = tool({ ATTACHNAME: 'Quarterly.PDF', AttachmentSize: 40 * 1024 * 1024 });

    const result = await download.handler({ attachmentId: 'a1' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("'Quarterly.PDF' is a PDF file of 40960 KB");
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an image over the cap by the size on its row, without fetching it', async () => {
    const { download, fetch } = tool({ ATTACHNAME: 'screen.png', AttachmentSize: 3 * 1024 * 1024 });

    const result = await download.handler({ attachmentId: 'a1' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('over the 1024 KB limit');
    expect(text(result)).toContain('Nothing was downloaded');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a text file too large to fetch, without fetching it', async () => {
    const { download, fetch } = tool({ ATTACHNAME: 'huge.log', AttachmentSize: 200 * 1024 * 1024 });

    const result = await download.handler({ attachmentId: 'a1' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('over the 5 MB this tool will fetch');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads a small text file whole', async () => {
    const { download, fetch } = tool(
      { ATTACHNAME: 'error.log', AttachmentSize: 11 },
      { bytes: new TextEncoder().encode('line one\nok'), contentType: 'text/plain' },
    );

    const result = await download.handler({ attachmentId: 'a1' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(text(result)).toBe('error.log (text/plain, 11 bytes)\n\nline one\nok');
  });

  it('decodes only the prefix it can show, never the whole buffer', async () => {
    const size = 3 * 1024 * 1024;
    const { download } = tool(
      { ATTACHNAME: 'big.log', AttachmentSize: size },
      { bytes: ascii(size), contentType: 'text/plain' },
    );
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');

    const result = await download.handler({ attachmentId: 'a1' });

    expect(text(result)).toContain('the first 20000 characters only');
    // Four bytes per character at most: 80,000 bytes, not three megabytes.
    const decoded = decode.mock.calls.map(([input]) => (input as Uint8Array).byteLength);
    expect(Math.max(...decoded)).toBeLessThanOrEqual(80_000);
  });

  it('says it is showing part of the file when fewer bytes arrive than the row declares', async () => {
    // A capped transport hands back the start of the file; that is not the whole file, however
    // short it is.
    const { download } = tool(
      { ATTACHNAME: 'cut.txt', AttachmentSize: 4096 },
      { bytes: new TextEncoder().encode('the start'), contentType: 'text/plain' },
    );

    const result = await download.handler({ attachmentId: 'a1' });

    expect(text(result)).toContain('cut.txt (text/plain, 4 KB) — the first 9 characters only');
  });

  it('still fetches a file whose row carries no size, and judges it by what arrives', async () => {
    const { download, fetch } = tool(
      { ATTACHNAME: 'dump' },
      { bytes: ascii(10), contentType: 'application/octet-stream' },
    );

    const result = await download.handler({ attachmentId: 'a1' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("'dump' is a binary file of 10 bytes");
  });
});
