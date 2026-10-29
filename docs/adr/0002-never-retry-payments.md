# ADR 0002 — Never retry payment initiation; three outcomes

- Status: accepted
- Date: 2026-10-28

## Context

Banks can book a payment and still return HTTP 500 or time out. BAC's onboarding notes say so
explicitly. A retry with a new MsgId pays twice. Not retrying, and reporting "failed", leads the
caller to pay again.

## Decision

`initiatePayment` is sent once. The result is `SUBMITTED`, `REJECTED` (provably not processed) or
`OUTCOME_UNKNOWN` (everything else, including anything thrown after validation). `OUTCOME_UNKNOWN`
carries guidance to check status, and never to resend with a new id. The only automatic repeat
allowed is one retry after HTTP 401, because a rejected token means the bank did not process the request.

## Consequences

Callers must handle three cases. The simulator reproduces each of them (IBK-SIM-002, 003, 007, 008).
