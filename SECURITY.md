# Security policy

This software builds and sends payment instructions. Please treat security issues accordingly.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting, under
_Security → Report a vulnerability_ on this repository. Include:

- the affected package and version;
- the steps to reproduce;
- the impact (for example a duplicate payment, a credential leak, or an allowlist bypass).

We aim to acknowledge reports within 3 business days and to agree a disclosure date with you.

## Supported versions

Only the latest minor release receives fixes while the project is 0.x.

## Scope

In scope:

- anything that can cause a payment to be sent twice, or to be sent when the caller believes it was not
  (SPEC IBK-PAY-001..003);
- leaks of connection secrets through logs, errors, responses or MCP tool schemas (IBK-SEC-001, IBK-SEC-003);
- bypasses of the endpoint allowlist or of redirect refusal (IBK-SEC-002);
- injection through bank responses into hosts (GraphQL, MCP, CLI).

Out of scope: vulnerabilities in a bank's own API, and deployments that turn off the documented
protections (for example a Function URL with `AuthType: NONE`).

## Hardening checklist for live use

- Keep `BANK_BACKEND=simulated` everywhere except the one deployment that needs live access.
- Put credentials in a secrets store (`BANK_CONNECTION_SECRET_ARN`), not in environment variables or code.
- Keep the GraphQL Function URL on `AWS_IAM`. Put MCP behind the JWT authorizer.
- Set `ReservedConcurrency` to cap the load you can put on a bank.
- Never auto-retry `initiatePayment`. Handle `OUTCOME_UNKNOWN` as described in [SPEC §6](spec/SPEC.md#6-payment-initiation).
- Review the [threat model](docs/threat-model.md).
