import type { IncomingMessage } from 'node:http';

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type BodyResult =
  | { ok: true; body: unknown }
  | { ok: false; status: 400 | 413; message: string };

/**
 * Reads and parses a JSON request body.
 *
 * The body has to be read here rather than handed straight to the transport, because routing
 * depends on its content: a POST with no session header is only legitimate when it is an
 * `initialize` request. The parsed value is then passed through, so it is never read twice.
 */
export async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buffer.length;
      if (total > maxBytes) {
        return { ok: false, status: 413, message: 'Request body too large' };
      }
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, status: 400, message: 'Could not read request body' };
  }

  if (total === 0) return { ok: true, body: undefined };

  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'Request body is not valid JSON' };
  }
}
