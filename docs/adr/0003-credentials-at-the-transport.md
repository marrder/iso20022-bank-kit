# ADR 0003 — Credentials travel with the transport, never with model-written arguments

- Status: accepted
- Date: 2026-10-28

## Decision

- **GraphQL:** the connection is a top-level field argument per connector, sent as a variable by the
  calling application.
- **MCP:** the connection comes from HTTP headers (`x-<id>-*`) or env vars (`<ID>_*`). Tool arguments
  are written by a language model and end up in its context and transcripts, so they never carry
  credentials (IBK-SEC-001).
- **Lambda:** optionally, a default connection from Secrets Manager.

## Consequences

The MCP client configuration holds the secrets, and the model never sees them. Errors tell the model
to ask the user to configure headers, never to ask for the secret in chat.
