Feature: Statements and balances
  As an ERP integrator
  I want one statement shape no matter which format the bank sends
  So that reconciliation code is written once

  @IBK-STM-001 @IBK-SIM-001
  Scenario Outline: Every statement format yields the same entries
    Given the simulated <bank> bank in <country> with account <account>
    When I request yesterday's statement in every format the bank supports
    Then every format lists the same 5 entries

    Examples:
      | bank | country | account   |
      | bac  | HN      | 999888666 |
      | bac  | SV      | 777000111 |
      | sim  | DE      | DE89370400440532013000 |

  @IBK-SIM-001 @IBK-MOD-001 @IBK-MOD-003
  Scenario: Balances are deterministic decimal strings in ISO 4217 currency
    Given the simulated bac bank in HN with account 999888666
    When I request the balance twice on fresh simulators
    Then both balances are "898500.69" "HNL"
