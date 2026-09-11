import { describe, expect, it } from 'vitest';
import { IvantiApiError, isIvantiNotFound, scrubErrorBody, truncate } from './errors.js';

const err = (status: number, body = ''): IvantiApiError =>
  new IvantiApiError({ status, method: 'GET', url: 'https://t/api/odata/x', body });

describe('IvantiApiError', () => {
  it('carries status, method and url', () => {
    const e = err(400, 'nope');

    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(400);
    expect(e.method).toBe('GET');
    expect(e.body).toBe('nope');
  });

  it('caps the body, because error bodies echo submitted values', () => {
    expect(err(400, 'x'.repeat(5000)).body).toMatch(/… \[truncated\]$/);
    expect(err(400, 'x'.repeat(5000)).body.length).toBeLessThan(1100);
  });
});

describe('truncate', () => {
  it('leaves a short body alone', () => {
    expect(truncate('short')).toBe('short');
  });

  it('measures bytes, not characters', () => {
    // Four-byte emoji: 3 of them exceed a 10-byte cap despite being 3 code points.
    expect(truncate('😀😀😀', 10)).toMatch(/truncated/);
  });
});

describe('isIvantiNotFound', () => {
  it('recognises a real 404', () => {
    expect(isIvantiNotFound(err(404))).toBe(true);
  });

  it('recognises Ivanti 400 dialects for a missing record', () => {
    expect(isIvantiNotFound(err(400, 'ISM_4000: Invalid key'))).toBe(true);
    expect(isIvantiNotFound(err(400, 'Attachment not found'))).toBe(true);
    expect(isIvantiNotFound(err(400, 'The resource does not exist'))).toBe(true);
  });

  it('does NOT treat a bare 400 as missing — it is usually a malformed request', () => {
    expect(isIvantiNotFound(err(400, 'Required field Incident.Customer must be provided'))).toBe(
      false,
    );
    expect(isIvantiNotFound(err(400, ''))).toBe(false);
  });

  it('ignores other statuses and non-Ivanti errors', () => {
    expect(isIvantiNotFound(err(500, 'not found'))).toBe(false);
    expect(isIvantiNotFound(new Error('not found'))).toBe(false);
    expect(isIvantiNotFound(undefined)).toBe(false);
  });
});

describe('scrubErrorBody', () => {
  const KEY = 'super-secret-api-key';

  it('redacts the API key wherever it appears', () => {
    const body = `{"error":"bad request for ${KEY}","retry":"${KEY}"}`;

    const scrubbed = scrubErrorBody(body, KEY);

    expect(scrubbed).not.toContain(KEY);
    expect(scrubbed.match(/\[REDACTED-API-KEY\]/g)).toHaveLength(2);
  });

  it('leaves 32-char hex RecIds alone — the model needs them out of error text', () => {
    const recId = '8E71E727DD5045C7B11EF634233437F1';

    expect(scrubErrorBody(`Invalid key ${recId}`, KEY)).toContain(recId);
  });

  it('redacts before capping, so a key near the cap cannot survive', () => {
    const body = 'x'.repeat(1000) + KEY + 'y'.repeat(1000);

    expect(scrubErrorBody(body, KEY)).not.toContain(KEY);
  });

  it('is a no-op on an empty key rather than redacting everything', () => {
    expect(scrubErrorBody('a body', '')).toBe('a body');
  });
});
