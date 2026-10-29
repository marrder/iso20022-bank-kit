# Threat model

This uses STRIDE, scoped to what the kit controls. "Bank" means the bank's API. "Caller" means whoever
invokes a host: an application, a person in GraphiQL or Postman, or a language model through MCP.

## Assets

1. **Money:** payment instructions and their outcomes.
2. **Credentials:** OAuth client secrets and mTLS keys.
3. **Financial data:** balances, statements, counterparties.

## Trust boundaries

```
caller ──(1)── host (GraphQL / MCP / CLI / Lambda) ──(2)── connector ──(3)── bank
                     │                                         │
                  LLM tool args (4)                      simulation engine
```

## Threats and mitigations

| #   | Threat                                                                                                   | Mitigation                                                                                                                                                                                   | Spec                     |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| T1  | **Duplicate payment** from automatic retries after a timeout or 5xx                                      | No automatic retry anywhere. Indeterminate results are `OUTCOME_UNKNOWN` with check-status guidance. The messageId is the idempotency key, and duplicates are reported as such               | IBK-PAY-001..003         |
| T2  | **Silent loss:** a 500 is treated as failed, so the caller pays again with a new id                      | `OUTCOME_UNKNOWN` guidance forbids resending with a different messageId. The simulator reproduces "booked, then 500"                                                                         | IBK-PAY-002, IBK-SIM-002 |
| T3  | **Credential exfiltration through a caller-chosen endpoint** (boundary 1→3)                              | `https` only, host allowlist, redirects refused                                                                                                                                              | IBK-SEC-002              |
| T4  | **Credentials in model context**: an LLM asked for the secret, or the secret in transcripts (boundary 4) | MCP tools have no credential arguments. Connections come from headers or env, and error text tells the model not to ask for secrets                                                          | IBK-SEC-001              |
| T5  | **Secret disclosure in logs and errors**                                                                 | `secret` fields are redacted, error messages never include connection values, and GraphQL masks unexpected errors                                                                            | IBK-SEC-003              |
| T6  | **Unauthenticated host access** (boundary 1)                                                             | CloudFormation: Function URL with `AWS_IAM`, MCP behind a JWT authorizer, throttling. Browser `Origin` is rejected unless allowlisted, and the local server validates `Host` (DNS rebinding) | —                        |
| T7  | **Confusing simulated and live data**                                                                    | Hosts expose the backend (`serviceInfo`, `bank_get_service_info`). The default is simulated                                                                                                  | IBK-SEC-004              |
| T8  | **Float rounding** changes amounts or control sums                                                       | Decimal strings end to end, and CtrlSum uses exact integer arithmetic                                                                                                                        | IBK-MOD-001, IBK-PAY-004 |
| T9  | **Malformed or hostile bank responses**                                                                  | Zod schemas validate every parsed document. Unknown codes map to `UNKNOWN`. A 2xx without a recognisable acknowledgement is `OUTCOME_UNKNOWN`, not `SUBMITTED`                               | IBK-MOD-002              |
| T10 | **Overloading a bank** (denial of service through the host)                                              | `ReservedConcurrency` and API Gateway throttling parameters                                                                                                                                  | —                        |
| T11 | **Supply chain**                                                                                         | Lockfile, Dependabot, CI on every PR, npm provenance on publish, minimal runtime dependencies                                                                                                | —                        |

## Out of scope

The bank's own security, operator key management beyond Secrets Manager integration, and deployments
that remove the template's authentication.
