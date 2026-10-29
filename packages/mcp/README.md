# @iso20022-bank-kit/mcp

MCP server generated from the installed connectors (MCP TypeScript SDK v2). Six tools, with `bank_initiate_payment` marked destructive and idempotent. Connections come from `x-<id>-*` headers or `<ID>_*` env vars, never from tool arguments.

```ts
import { createMcpFetch, createBankMcpServer } from '@iso20022-bank-kit/mcp';
```

Part of [iso20022-bank-kit](../../README.md). Licensed under Apache-2.0.
