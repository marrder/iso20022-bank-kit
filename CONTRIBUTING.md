# Contributing

Thanks for helping. This kit moves money, so the bar is "specified, tested, and boring".

## Setup

```sh
nvm use            # Node 22 (20.19+ works)
npm install
npm run check      # lint, typecheck, unit, Gherkin, e2e, spec traceability
```

Useful loops:

```sh
npm run test:watch                 # unit tests
npm run test:bdd                   # Cucumber
npm run dev                        # local GraphQL + MCP on :4000 (simulated)
npm run ibk -- <command>           # the CLI from source
```

## Ground rules

1. **Spec first.** A behaviour change that callers can observe needs an edit to [spec/SPEC.md](spec/SPEC.md):
   a new requirement or a change to an existing one. Mention the requirement ID in your tests.
   `npm run spec:trace` fails if a MUST requirement has no test.
2. **No bank documentation in the repo.** Bank onboarding packs are usually not redistributable.
   Use synthetic fixtures, and keep real examples in `fixtures/private/` (git-ignored).
3. **No float money.** Amounts are decimal strings end to end (IBK-MOD-001).
4. **Never retry payments.** Not in connectors, not in hosts, not in tests (IBK-PAY-001).
5. **Secrets stay secret.** Mark connection fields `secret: true`. Never put credentials in MCP tool
   arguments (IBK-SEC-001).
6. **Conventional commits** (`feat:`, `fix:`, `docs:` …). Add a changeset (`npm run changeset`) for
   anything that changes a published package.

## Adding a connector

Read [docs/writing-a-connector.md](docs/writing-a-connector.md). A new built-in connector needs:

- a package `packages/connector-<id>`, with a README that carries the "unofficial, not affiliated" notice;
- a simulated mode that runs its real wire codec against the simulation engine (IBK-PLG-004);
- a passing conformance run in `packages/conformance/test`;
- Gherkin examples in `features/` for the bank's countries.

## Pull requests

- Keep each PR focused, and include tests at the lowest layer that catches the bug.
- CI must be green. Two maintainers review anything under `packages/core` or that touches payment initiation.
