# ADR 0001 — Banks are connector plugins over one ISO 20022 core

- Status: accepted
- Date: 2026-10-28

## Context

The first integration (BAC Credomatic) showed that roughly 90% of the work is generic ISO 20022:
building pain.001, parsing pain.002 and camt.05x, MT940/942, outcome handling. The remaining 10% is bank
conventions: envelopes, BIC aliases, non-ISO codes, endpoints.

## Decision

The generic work lives in `iso20022`, `swift-mt` and `core`. Each bank is a `BankConnector` object that
declares its countries, capabilities and connection fields, and implements `open()`. Hosts generate
their surface (GraphQL fields and enums, MCP tool enums, env and header names) from the installed
connectors.

## Consequences

- Adding a bank means adding a package, with no changes to the hosts.
- The client enforces the SPEC rules once, so connectors cannot skip validation or misclassify thrown errors.
- The GraphQL schema varies with the installed connectors. Clients should introspect.
