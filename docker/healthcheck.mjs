/**
 * Container health check.
 *
 * Runs inside a distroless image: no shell, no curl, so it is a Node script the
 * image's own runtime executes. It asks the same `/health` endpoint a load
 * balancer would, on the loopback interface, whatever address the server binds.
 *
 * A stdio-only deployment serves no HTTP at all. Reporting such a container
 * unhealthy for running exactly as configured would be worse than not checking,
 * so that case passes.
 */
const httpOn = /^(1|true|yes|on)$/i.test(process.env.HTTP_TRANSPORT_ON ?? '');
if (!httpOn) process.exit(0);

const port = process.env.MCP_PORT ?? '3000';
const timeout = Number(process.env.HEALTHCHECK_TIMEOUT_MS ?? '4000');

try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    process.stderr.write(`health: HTTP ${String(response.status)}\n`);
    process.exit(1);
  }
  const body = await response.json();
  // The endpoint answers anonymously with `{"status":"ok"}` and nothing else.
  process.exit(body?.status === 'ok' ? 0 : 1);
} catch (error) {
  process.stderr.write(`health: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exit(1);
}
