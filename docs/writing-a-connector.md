# Writing a connector

A connector teaches the kit one bank's API. Hosts (SDK, GraphQL, MCP, CLI, Lambda) generate their
surface from it. The core client applies the [SPEC](../spec/SPEC.md) rules around it, so a connector
contains only bank-specific code.

## 1. Declare the bank

```ts
import { defineConnector } from '@iso20022-bank-kit/core';

export const acme = defineConnector({
  id: 'acme', // GraphQL field `acme`, env prefix ACME_, headers x-acme-*
  name: 'Acme Bank',
  version: '0.1.0',
  description: 'Acme Bank corporate API (unofficial connector)',
  countries: [
    {
      code: 'CO',
      name: 'Colombia',
      bankBic: 'ACMECOBB',
      localCurrency: 'COP',
      requiresIban: false,
      intrabankClearingCode: '0999',
      utcOffsetMinutes: -300,
    },
  ],
  capabilities: {
    balance: true,
    statementFormats: ['CAMT053'],
    paymentInitiation: true,
    paymentStatus: true,
    routes: ['INTRABANK', 'DOMESTIC_CLEARING'],
  },
  connectionFields: [
    { key: 'clientId', description: 'OAuth2 client id', required: true },
    { key: 'clientSecret', description: 'OAuth2 client secret', required: true, secret: true },
    { key: 'environment', description: 'API environment', values: ['SANDBOX', 'PRODUCTION'], default: 'SANDBOX' },
  ],
  defaultAllowedHosts: ['*.acme-bank.example'],
  validatePayment: (batch) => [], // bank-only rules; generic rules already run
  open(connection, ctx) {
    /* return a BankSession */
  },
});
```

Hosts read this declaration as follows:

- **GraphQL:** a `acme(connection: AcmeConnectionInput)` field. `values` become enums (`AcmeEnvironment`).
- **MCP:** connections come from `x-acme-client-id` / `x-acme-client-secret` headers, or `ACME_CLIENT_ID` /
  `ACME_CLIENT_SECRET` env vars. They never become tool arguments.
- **Everywhere:** countries join the `Country` enum. Undeclared capabilities fail as `UNSUPPORTED`
  without calling the bank (IBK-PLG-002).

## 2. Build messages with a profile, not a fork

Use the generic builders in `@iso20022-bank-kit/iso20022`, and express the bank's conventions as a
`MessageProfile` (IBK-PLG-003): header `MsgDefIdr` aliases, the `ReqdMsgNmId` values, `Ccy` vs `-Ccy`,
and countries where account type is omitted. BAC's whole difference from the defaults is
[about ten lines](../packages/connector-bac/src/profile.ts).

## 3. Implement `open()`

`open(connection, ctx)` returns a `BankSession` with `getBalance`, `getStatement`, `getPaymentStatus` and
`initiatePayment`.

- **Live:** call `assertAllowedUrl` on every caller-supplied URL (IBK-SEC-002), and use
  `createOAuthJsonClient` for OAuth2 client credentials. It also gives you mTLS, timeouts, redirect
  refusal and the single 401 retry (IBK-AUTH-001).
- **Simulated (`ctx.backend === 'simulated'`):** translate your wire format to and from
  `ctx.simulation`, the shared `SimulationEngine`. Then simulated mode exercises your real
  builders and parsers (IBK-PLG-004). See
  [connector-bac/src/simulated.ts](../packages/connector-bac/src/simulated.ts).
- **`initiatePayment`** must send exactly once (IBK-PAY-001). Classify HTTP responses with
  `classifyPaymentHttp`. Anything you throw is reported to the caller as `OUTCOME_UNKNOWN`, unless it
  is a `TransportError` with `definitelyNotProcessed`.
- Map bank codes with the `codeMap`s, and keep the raw code (IBK-MOD-002). Pass
  `currencyAliases` for non-ISO currencies (IBK-MOD-003).

## 4. Prove it

```sh
npm run ibk -- conformance --plugin ./path/to/acme.js [--country CO] [--iban ...]
```

```ts
// In your own test suite (Vitest shown; any runner works)
import { conformanceCases, createHarness } from '@iso20022-bank-kit/conformance';
it.each(conformanceCases.map((c) => [c.title, c]))('%s', (_, c) => c.run(createHarness({ connector: acme })));
```

A full pass means your connector behaves like every other connector in every host.

## 5. Ship it

- Put **"Unofficial; not affiliated with or endorsed by <Bank>"** in the package README.
- Never commit the bank's documentation. Write synthetic fixtures, and keep real examples in
  `fixtures/private/`.
- Publish it as your own package. Hosts load it with `--plugin <module>`, or by adding it to the
  connectors array when using the SDK.
