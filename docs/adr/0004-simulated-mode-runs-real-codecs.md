# ADR 0004 — Simulated mode is a feature flag and runs the connector's real codecs

- Status: accepted
- Date: 2026-10-28

## Decision

`BANK_BACKEND=simulated|live` is a host-level flag, and simulated is the default. In simulated mode the
connector still builds and parses its real wire messages. Only the transport is swapped, for a
simulator that translates them to the shared `SimulationEngine`.

## Consequences

- Teams can build and demo before they have bank credentials, and the code that runs is the code that
  will run against the bank.
- The engine's scenarios are specified (SPEC clause 11), so every connector's simulated mode behaves
  identically and the conformance suite can run anywhere.
