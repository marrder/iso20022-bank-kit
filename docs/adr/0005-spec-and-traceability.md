# ADR 0005 — An ISO-style normative spec with enforced traceability

- Status: accepted
- Date: 2026-10-28

## Decision

`spec/SPEC.md` uses ISO/IEC directive conventions: scope, normative references, terms, numbered
requirements, and RFC 2119 keywords. Each requirement has an ID. Conformance cases, Gherkin scenarios
and unit tests reference those IDs, and `npm run spec:trace` fails CI if a MUST requirement has no test.

## Consequences

Behaviour changes start as spec changes. Third-party connectors can claim conformance by running the
same suite.
