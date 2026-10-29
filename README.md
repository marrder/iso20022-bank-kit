# iso20022-bank-kit

**A bank-agnostic ISO 20022 toolkit for corporate banking APIs.** It includes:

- message builders and parsers;
- SWIFT MT940/MT942 support;
- a pluggable connector model;
- a deterministic simulated bank;
- generated GraphQL and MCP servers;
- a developer CLI;
- one plain CloudFormation template;
- a normative specification with a conformance suite.

> [!IMPORTANT]
> **Unofficial and independent.** This project is not affiliated with, sponsored by, or endorsed by
> BAC Credomatic or any other bank. Bank names identify the APIs a connector targets, and nothing more.
> No bank documentation is included, and all test data is synthetic.
>
> **This software can move money.** It ships with the simulated backend on by default, so you have to
> switch to live deliberately. Read [SECURITY.md](SECURITY.md) and the [threat model](docs/threat-model.md)
> before pointing it at a real bank. It comes with no warranty (Apache-2.0, sections 7–8).

## Why

Corporate payment and reporting APIs are converging on **ISO 20022** (pain.001, pain.002, camt.052/053,
CBPR+). Each bank still wraps them differently: its own envelopes, BIC aliases, non-ISO codes, and MT
statements in base64. Integrations also tend to re-learn the same expensive lessons:

- a **500 after a payment** does not mean it failed;
- the **MsgId** is your idempotency key;
- **"RJCT"** can mean "partially rejected";
- MT940 and camt.053 should reconcile **identically**.

This kit puts those lessons into one specified, tested core. Each bank becomes a small plugin.

## What's inside

| Package                                                                                 | What it does                                                                                                                     |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`@iso20022-bank-kit/iso20022`](packages/iso20022)                                      | Domain model, ISO code maps, validators (IBAN mod-97, BIC, decimals), JSON message builders and parsers, JSON Schemas            |
| [`@iso20022-bank-kit/swift-mt`](packages/swift-mt)                                      | MT940/MT942 parser and writer, normalised to the same `Statement` as camt.053                                                    |
| [`@iso20022-bank-kit/core`](packages/core)                                              | **The Node SDK.** The connector plugin contract, a client that enforces [SPEC](spec/SPEC.md) rules, and an OAuth2/mTLS transport |
| [`@iso20022-bank-kit/simulator`](packages/simulator)                                    | Deterministic bank engine with failure scenarios, a ready-made `sim` connector, and fixture factories                            |
| [`@iso20022-bank-kit/connector-bac`](packages/connector-bac)                            | BAC Credomatic API Center 2.0 plugin (PA, CR, NI, HN, SV, GT)                                                                    |
| [`@iso20022-bank-kit/conformance`](packages/conformance)                                | Conformance suite that any connector can run, traceable to SPEC requirements                                                     |
| [`@iso20022-bank-kit/graphql`](packages/graphql)                                        | GraphQL server generated from the installed plugins, with introspection on and strict enums                                      |
| [`@iso20022-bank-kit/mcp`](packages/mcp)                                                | MCP server generated from the installed plugins. Credentials never appear in tool arguments                                      |
| [`@iso20022-bank-kit/cli`](packages/cli)                                                | `ibk`: validate messages, MT940→camt.053, IBAN/BIC tools, build pain.001, serve, run conformance                                 |
| [`packages/lambda`](packages/lambda) + [`deploy/cloudformation`](deploy/cloudformation) | One Lambda serving `/graphql` and `/mcp`, deployed with one plain CloudFormation template                                        |

```
             ┌──────── hosts ────────┐
  SDK  GraphQL  MCP  CLI  Lambda     │  generated from the installed connectors
             └──────────┬────────────┘
                        │  BankClient: SPEC rules (validation, outcome classification, capabilities)
             ┌──────────┴────────────┐
             │   connector plugins   │  bac · sim · yours
             └──────────┬────────────┘
       live: OAuth2/mTLS HTTP │ simulated: the plugin's own wire codec ⇄ simulation engine
```

## Quick start

```sh
git clone https://github.com/marrder/iso20022-bank-kit && cd iso20022-bank-kit
npm install
npm run dev          # GraphQL http://localhost:4000/graphql (GraphiQL) and MCP http://localhost:4000/mcp, simulated
```

### Node SDK

```ts
import { createBankClient } from '@iso20022-bank-kit/core';
import { bacConnector } from '@iso20022-bank-kit/connector-bac';
import { simulationFor } from '@iso20022-bank-kit/simulator';

const connectors = [bacConnector];
const client = createBankClient({ connectors, backend: 'simulated', simulation: simulationFor(connectors) });
// Live: createBankClient({ connectors, backend: 'live', allowedHosts: ['*.baccredomatic.com'] })
//       client.session('bac', { clientId, clientSecret, clientBic, ownerBic })
const bac = client.session('bac');

const balance = await bac.getBalance({ country: 'HN', account: { number: '999888666' } });
const stmt = await bac.getStatement({ country: 'HN', account: { number: '999888666' }, format: 'MT940', fromDate: '2026-10-27' });

const outcome = await bac.initiatePayment(batch); // SUBMITTED | REJECTED | OUTCOME_UNKNOWN; never retried
if (outcome.result === 'OUTCOME_UNKNOWN') {
  // The debit may have happened: check status before doing anything (SPEC IBK-PAY-002).
  await bac.getPaymentStatus({ country: 'HN', messageId: batch.messageId });
}
```

### GraphQL

Each plugin becomes a top-level field that takes its own typed connection, so credentials live at the top level:

```graphql
query ($c: BacConnectionInput) {
  bac(connection: $c) {
    balance(country: HN, account: { number: "999888666" }) {
      balances {
        type
        amount
        currency
      }
    }
  }
}
```

### MCP

The server has six tools, including `bank_initiate_payment`, which is marked destructive and idempotent
by `message_id`. Over HTTP the connection comes from `X-<ID>-*` headers; over stdio it comes from
`<ID>_*` env vars. Credentials are never tool arguments.

```sh
npm run build && claude mcp add bank -e BANK_BACKEND=simulated -- node "$PWD/packages/cli/dist/bin.js" mcp
```

### CLI

```sh
npm run ibk -- validate pain001.json --connector bac   # schema + generic + BAC rules, every problem at once
npm run ibk -- mt statement.mt940 --to camt053         # MT940/942 (or BAC "F{base64}") → camt.053 JSON
npm run ibk -- iban GB52SIMB00000012345678             # or: ibk iban --make GB SIMB00000012345678
npm run ibk -- schema --out schemas/                   # JSON Schema for every supported message
npm run ibk -- conformance --plugin ./my-connector.js  # SPEC conformance for your plugin
```

## Feature flag: simulated vs live

`BANK_BACKEND=simulated` (the default) serves every request from the simulation engine, using the
connector's real wire codec. `BANK_BACKEND=live` calls the banks. The [simulated bank](spec/SPEC.md#11-simulation-engine)
has fixed scenarios you can trigger on purpose:

| Trigger                           | Result                                                            |
| --------------------------------- | ----------------------------------------------------------------- |
| messageId `MOCK-500…`             | Booked, then HTTP 500, which the kit reports as `OUTCOME_UNKNOWN` |
| messageId `MOCK-TIMEOUT…`         | Booked, then a timeout                                            |
| messageId `MOCK-503…`             | Nothing booked, HTTP 503                                          |
| Reused messageId                  | `REJECTED`, duplicate, code 1010                                  |
| Account `000000000`               | HTTP 422                                                          |
| Creditor name containing `REJECT` | That transfer fails and the batch becomes `PARTIAL`               |

## Specification and tests

[`spec/SPEC.md`](spec/SPEC.md) (IBK-1) is a normative, ISO-style specification with 29 numbered
requirements in RFC 2119 language. They are verified at four levels:

| Layer        | Command                                                                                                                     | What it covers                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Unit         | `npm test`                                                                                                                  | Every package with Vitest: codecs, validators, the transport against a local fake bank, hosts                               |
| Gherkin      | `npm run test:bdd`                                                                                                          | [`features/`](features), the requirements as Cucumber scenarios tagged `@IBK-…` and run against the SDK for every connector |
| End to end   | `npm run test:e2e`                                                                                                          | A real server over sockets, MCP over HTTP and stdio, CLI subprocesses, the Lambda bundle, and the Postman collection        |
| Postman      | `postman collection run postman/collections/iso20022-bank-kit -e "postman/environments/Local (simulated).environment.yaml"` | Plain HTTP requests with `pm.test` assertions, runnable on any Postman plan                                                 |
| Conformance  | `npm run ibk -- conformance --connector bac`                                                                                | The SPEC suite for any plugin                                                                                               |
| Traceability | `npm run spec:trace`                                                                                                        | Fails if a MUST requirement has no test                                                                                     |

`npm run check` runs all of the above, plus lint and type-checking.

## Writing a connector

A connector is one object: countries, capabilities, connection fields, an optional `validatePayment`,
and `open()`. See [docs/writing-a-connector.md](docs/writing-a-connector.md) and the
[Acme example](examples/acme-connector/index.ts). If your plugin passes `ibk conformance`, it behaves
like every other connector in every host.

## Deploy

```sh
npm run bundle:lambda
aws cloudformation package --template-file deploy/cloudformation/template.yaml --s3-bucket <bucket> --output-template-file deploy/cloudformation/packaged.yaml
aws cloudformation deploy --template-file deploy/cloudformation/packaged.yaml --stack-name ibk --capabilities CAPABILITY_IAM
```

See [deploy/cloudformation/README.md](deploy/cloudformation/README.md) for parameters, the
Secrets Manager default connection, and the JWT-protected MCP endpoint.

## Project

[CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) ·
[Architecture decisions](docs/adr) · [Threat model](docs/threat-model.md) · [License: Apache-2.0](LICENSE)
