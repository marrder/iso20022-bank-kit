# IBK-1 — ISO 20022 Bank Kit: connector and host requirements

|          |                                 |
| -------- | ------------------------------- |
| Document | IBK-1                           |
| Edition  | 0.1 (draft)                     |
| Status   | Working draft. Open for comment |
| Date     | 2026-10-28                      |

## Foreword

This document specifies how software built with the ISO 20022 Bank Kit talks to banks. It has two parts.
Bank **connectors** translate one bank's API. **Hosts** expose connectors to applications, through the
Node SDK, GraphQL, MCP, the CLI or a Lambda function. The requirements focus on behaviour that, if wrong,
causes duplicate payments, lost money or leaked credentials.

## 1 Scope

This document specifies:

- a bank-agnostic domain model for balances, statements, payment initiation and payment status, derived
  from ISO 20022 (clause 5);
- requirements on payment initiation and status reporting (clauses 6, 7);
- requirements on statements (clause 8);
- security requirements (clause 9);
- requirements on connector plugins (clause 10);
- the behaviour of the simulated bank (clause 11);
- how conformance is tested (clause 12).

It does not specify any bank's proprietary API. Those belong in connector documentation.

## 2 Normative references

- ISO 20022 (all parts), _Financial services — Universal financial industry message scheme_: messages
  pain.001.001.03, pain.002.001.03, camt.052.001.08, camt.053.001.08, camt.060.001.05, tsmt.038.001.03,
  admi.002.001.01, admi.004.001.02, head.001.001.02
- ISO 4217, _Codes for the representation of currencies_
- ISO 3166-1, _Codes for the representation of names of countries — Part 1: Country code_ (alpha-2)
- ISO 13616-1, _International bank account number (IBAN)_
- ISO 9362, _Business identifier code (BIC)_
- SWIFT Standards MT, _Category 9: MT940, MT942_
- IETF RFC 2119 and RFC 8174, _Key words for use in RFCs to Indicate Requirement Levels_

## 3 Terms and definitions

**3.1 connector** — a plugin implementing the `BankConnector` contract for one bank.

**3.2 host** — software that exposes connectors to callers (SDK client, GraphQL server, MCP server, CLI, Lambda).

**3.3 session** — a connector bound to one set of credentials.

**3.4 batch** — one payment initiation message (pain.001 `GrpHdr` and its payment information).

**3.5 messageId** — the batch's `GrpHdr/MsgId`.

**3.6 indeterminate outcome** — a payment initiation where the bank's acceptance or rejection is not known.

**3.7 simulated backend** — a host mode in which every operation is served by the simulation engine (clause 11).

## 4 Conventions and conformance classes

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY and
OPTIONAL are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in
all capitals.

Every requirement has an identifier, `IBK-<AREA>-<NNN>`, and states which class it applies to:

- **C**: connector
- **H**: host
- **S**: simulation engine

A connector or host conforms when it meets every MUST and MUST NOT that applies to its class. Clause 12
says how this is tested.

## 5 Domain model

**IBK-MOD-001** (C, H): Monetary amounts MUST be represented as decimal strings and MUST NOT pass
through binary floating point between the bank response and the caller.

**IBK-MOD-002** (C): When a bank code is mapped to a domain enumeration, the raw code MUST be kept
alongside it. A code with no mapping MUST map to `UNKNOWN`, and the connector MUST NOT fail because of it.

**IBK-MOD-003** (C): Currency codes MUST be reported as ISO 4217 codes. A connector MUST translate a
bank's non-ISO codes, for example `LPS` → `HNL`.

## 6 Payment initiation

**IBK-PAY-001** (C, H): A payment initiation MUST be transmitted at most once per call. Neither
connectors nor hosts SHALL retry it automatically, except as allowed by IBK-AUTH-001.

**IBK-PAY-002** (C, H): The result of a payment initiation MUST be exactly one of:

- `SUBMITTED`: the bank acknowledged receipt;
- `REJECTED`: the bank definitely did not accept the batch. This means an HTTP 4xx response, an explicit
  rejection message, or a failure proven to happen before transmission;
- `OUTCOME_UNKNOWN`: anything else, including HTTP 5xx, timeouts, network errors, and acknowledgements
  that cannot be parsed.

An `OUTCOME_UNKNOWN` result MUST tell the caller to check the payment status before acting, and MUST NOT
suggest resending with a different messageId.

**IBK-PAY-003** (C, H): The messageId is the idempotency key. If a batch is resent with a messageId the
bank has already received, the result MUST be `REJECTED` with `duplicate = true`.

**IBK-PAY-004** (C): `NbOfTxs` and `CtrlSum` MUST be derived from the transfers in the batch, using exact
decimal arithmetic. Callers MUST NOT be able to supply them.

**IBK-PAY-005** (H): A batch MUST be validated before it is transmitted, against both the generic rules
and the connector's own rules. All problems MUST be reported together, and nothing SHALL be transmitted
when any problem exists.

## 7 Payment status

**IBK-STS-001** (C, H): Every payment status MUST map to one coarse state:

- `COMPLETED`: ACSC, ACCC;
- `FAILED`: RJCT, CANC;
- `PARTIAL`: PART, PATC;
- `UNKNOWN`: unmapped codes;
- `IN_PROGRESS`: every other status.

**IBK-STS-002** (C): When a group or payment-information status reports rejection but its per-status
counts include both failed and non-failed transfers, the state MUST be `PARTIAL`.

## 8 Statements

**IBK-STM-001** (C): Statements in every supported format (camt.053, MT940, MT942) MUST be normalised to
the same `Statement` structure. For the same ledger and period, the entries MUST be equal in reference,
amount, credit/debit indicator and transaction type.

**IBK-STM-002** (C): For SWIFT MT formats, the decoded FIN text SHOULD be returned in `raw`.

## 9 Security

**IBK-SEC-001** (H): Hosts whose tool arguments are written by a language model (for example MCP) MUST NOT
accept credentials as tool arguments. Credentials MUST come from the host's transport or configuration.

**IBK-SEC-002** (C): A live endpoint or token URL supplied at runtime MUST be an `https` URL on a
configured host allowlist. HTTP redirects MUST NOT be followed.

**IBK-SEC-003** (C, H): Secret connection fields MUST NOT be logged, echoed in error messages, or
returned in responses.

**IBK-SEC-004** (H): Hosts MUST make it discoverable whether they serve the simulated or the live backend.

**IBK-AUTH-001** (C): When the bank rejects an access token (HTTP 401), the connector MAY obtain a new
token and repeat the request once. It MUST NOT repeat it more than once.

## 10 Connector plugins

**IBK-PLG-001** (C): A connector MUST declare its countries, capabilities (balance, statement formats,
payment initiation, payment status, transfer routes) and connection fields.

**IBK-PLG-002** (H): A request for an undeclared capability, format or country MUST fail with an
`UNSUPPORTED` error without contacting the bank.

**IBK-PLG-003** (C): Bank-specific message conventions SHOULD be expressed as a message profile, not as
forks of the generic builders.

**IBK-PLG-004** (C): A connector's simulated mode SHOULD exchange its real wire format with a simulator,
so that its builders and parsers are exercised.

## 11 Simulation engine

**IBK-SIM-001** (S): Each account MUST start with an opening balance derived only from the account
identifier, plus five seed entries booked on the day before "now". Repeated runs therefore produce
identical figures.

**IBK-SIM-002** (S): A batch whose messageId starts with `MOCK-500` MUST be booked, and the response MUST
be HTTP 500. Hosts MUST report this as `OUTCOME_UNKNOWN`.

**IBK-SIM-003** (S): A batch whose messageId starts with `MOCK-503` MUST NOT be booked, and the response
MUST be HTTP 503.

**IBK-SIM-004** (S): The first status query for a batch MUST report it as received and technically
accepted. Later queries MUST report the final status.

**IBK-SIM-005** (S): A transfer whose creditor name contains `REJECT` (any case) MUST be rejected in the
final status, without affecting the other transfers.

**IBK-SIM-006** (S): Operations on account number `000000000` MUST be rejected with HTTP 422.

**IBK-SIM-007** (S): A batch whose messageId starts with `MOCK-TIMEOUT` MUST be booked, and the call MUST
then fail with a timeout.

**IBK-SIM-008** (S): A second submission with an already-received messageId MUST be rejected as a
duplicate, with reason code `1010`.

## 12 Conformance testing

12.1 The package `@iso20022-bank-kit/conformance` contains test cases. Each one names the requirement it
verifies. It runs against any connector in simulated mode.

12.2 The Gherkin features in `features/` restate the requirements as executable scenarios. Every scenario
is tagged with the requirement identifiers it covers.

12.3 `npm run spec:trace` fails if any MUST-level requirement in this document is not referenced by at
least one conformance case, feature scenario or test.

## Annex A (informative) — Code mappings

| Domain                                                                                                                                           | ISO 20022 / SWIFT                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| CreditDebit CREDIT / DEBIT                                                                                                                       | CRDT / DBIT                                                     |
| BalanceType OPENING_BOOKED, CLOSING_BOOKED, OPENING_AVAILABLE, CLOSING_AVAILABLE, INTERIM_AVAILABLE, INTERIM_BOOKED, FORWARD_AVAILABLE, EXPECTED | OPBD, CLBD, OPAV, CLAV, ITAV, ITBD, FWAV, XPCD                  |
| EntryStatus BOOKED, PENDING, INFORMATION, FUTURE                                                                                                 | BOOK, PDNG, INFO, FUTR                                          |
| PaymentMethod TRANSFER, CHECK                                                                                                                    | TRF, CHK                                                        |
| CategoryPurpose SUPPLIERS, PAYROLL                                                                                                               | SUPP, SALA                                                      |
| AccountType SAVINGS, CHECKING, LOAN                                                                                                              | SVGS, CASH, LOAN                                                |
| TransferRoute INTRABANK / DOMESTIC_CLEARING / CROSS_BORDER                                                                                       | CdtrAgt ClrSysMmbId (own code) / ClrSysMmbId (other bank) / BIC |
| MT balance tags 60F/60M, 62F/62M, 64, 65                                                                                                         | OPBD, CLBD, CLAV, FWAV                                          |

## Annex B (informative) — Bibliography

- SWIFT, _CBPR+ Usage Guidelines_
- ISO 20022 JSON schema conventions (ISO 20022 Registration Authority)
