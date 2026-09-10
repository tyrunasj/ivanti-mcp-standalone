# Postman

`ivanti-mcp.postman_collection.json` — 15 requests exercising the server over streamable HTTP.

## Setup

1. Start the server in bearer mode:

   ```bash
   HTTP_TRANSPORT_ON=true STDIO_TRANSPORT_ON=false AUTH_MODE=bearer \
   BEARER_TOKEN=<token> MCP_BIND=127.0.0.1 MCP_PORT=3000 \
   MCP_PUBLIC_URL=http://127.0.0.1:3000/mcp TRUSTED_ORIGINS=http://localhost \
   pnpm start
   ```

2. Import the collection, set the `bearerToken` collection variable to the same value.
3. Run **Session / 1. Initialize** first — it captures `Mcp-Session-Id` into the `sessionId`
   variable that every later request reuses.

The whole collection runs under the Collection Runner; every request asserts its expected status.

## Things that trip people up

- **`Accept: application/json, text/event-stream` is required.** The transport rejects a POST
  without it, and the failure looks like a malformed request rather than a missing header.
- **Responses are `text/event-stream`.** The JSON-RPC payload sits on a `data:` line, so
  Postman's JSON viewer shows nothing useful — the test scripts parse it and `console.log` the
  result.
- **The session id is a response *header***, not part of the body.
- **Auth is checked on every request.** Holding a valid session id is not a way past the token —
  there is a negative test for exactly that.

## Layout

| Folder | What it proves |
|---|---|
| Health & discovery | `/health` and the RFC 9728 metadata document are reachable without a token |
| Session | initialize → tools/list → tools/call → delete, in order |
| Negative — auth | no token, wrong token of equal length, wrong scheme, and session-without-token all give 401 |
| Negative — protocol | untrusted Origin 403, unknown session 404, no-session-not-initialize 400, malformed JSON 400, unknown path 404 |

The negative folders are the point. A server that passes the happy path and silently accepts a
wrong token looks perfectly healthy.
