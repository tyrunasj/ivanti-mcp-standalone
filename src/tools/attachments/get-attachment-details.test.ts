import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import type { Logger } from '../../logger.js';
import { createGetAttachmentDetailsTool } from './get-attachment-details.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const body = (result: CallToolResult): Record<string, never> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, never>;
};

const ROW = {
  RecId: 'a1',
  ATTACHNAME: 'Work Order.png',
  ATTACHDESC: null,
  AttachmentSize: 3687,
  ParentLink_Category: 'ServiceReqTemplate',
  ParentLink_RecID: 'srt1',
  CreatedBy: 'ATaylor',
  AttachmentHost: 'localhost:80',
};

const tool = (responses: Record<string, unknown>) => {
  const { connection, urls } = connectionFixture({ responses });
  return { urls, tool: createGetAttachmentDetailsTool({ connection, gate: OPEN_GATE, logger: logger() }) };
};

describe('get_attachment_details', () => {
  it('reads the metadata through the Business Object, not the download endpoint', async () => {
    const { tool: details, urls } = tool({ attachments: { value: [ROW] } });

    const result = body(await details.handler({ attachmentId: 'a1' }));

    expect(result.attachment).toEqual({
      RecId: 'a1',
      ATTACHNAME: 'Work Order.png',
      AttachmentSize: 3687,
      ParentLink_Category: 'ServiceReqTemplate',
      ParentLink_RecID: 'srt1',
      CreatedBy: 'ATaylor',
    });
    // /rest/Attachment?ID= streams the file itself; this must not fetch bytes.
    expect(urls[0]).toContain('/api/odata/businessobject/attachments');
  });

  it('says plainly when there is no such attachment', async () => {
    const { tool: details } = tool({});

    const result = await details.handler({ attachmentId: 'gone' });

    expect(result.isError).toBe(true);
  });
});
