# Private fixtures

Everything in this folder except this README is git-ignored.

Bank documentation and examples are usually not licensed for redistribution, so they must never be
committed. If you have a bank's onboarding pack, convert its examples to strict JSON and drop them here.
The optional tests pick them up automatically, for example:

- `fixtures/private/bac/*.json` → the "BAC documentation examples (private fixtures)" suite in `packages/connector-bac/test`.
