Feature: Payment initiation
  As a treasury application
  I want every payment attempt to have exactly one clear outcome
  So that money is never sent twice and never silently lost

  Scenario Outline: A batch is submitted and tracked to completion
    Given the simulated <bank> bank in <country> with account <account>
    When I submit a valid payment batch
    Then the outcome is SUBMITTED
    And the first status check says IN_PROGRESS
    And the next status check says COMPLETED

    @IBK-PAY-002 @IBK-STS-001 @IBK-SIM-004
    Examples:
      | bank | country | account                 |
      | bac  | HN      | 999888666               |
      | bac  | CR      | CR41010200009998886660  |
      | sim  | US      | 999888666               |

  Scenario Outline: Resending the same messageId cannot pay twice
    Given the simulated <bank> bank in <country> with account <account>
    When I submit a valid payment batch
    And I submit the same batch again
    Then the outcome is REJECTED as a duplicate with bank code "1010"

    @IBK-PAY-003 @IBK-SIM-008
    Examples:
      | bank | country | account   |
      | bac  | HN      | 999888666 |
      | sim  | MX      | 999888666 |

  Scenario Outline: A server error after the bank booked the payment is not treated as a failure
    Given the simulated <bank> bank in <country> with account <account>
    When I submit a valid payment batch with messageId starting "MOCK-500"
    Then the outcome is OUTCOME_UNKNOWN
    And the guidance says to check the payment status
    And the batch was transmitted exactly once
    And the payment status lookup finds the batch

    @IBK-PAY-001 @IBK-PAY-002 @IBK-SIM-002
    Examples:
      | bank | country | account   |
      | bac  | GT      | 999888666 |
      | sim  | US      | 999888666 |

  Scenario Outline: A timeout after booking is indeterminate
    Given the simulated <bank> bank in <country> with account <account>
    When I submit a valid payment batch with messageId starting "MOCK-TIMEOUT"
    Then the outcome is OUTCOME_UNKNOWN with category "TIMEOUT"
    And the batch was transmitted exactly once

    @IBK-PAY-001 @IBK-SIM-007
    Examples:
      | bank | country | account   |
      | bac  | PA      | 999888666 |

  @IBK-PAY-002 @IBK-SIM-003
  Scenario: An unavailable bank books nothing
    Given the simulated bac bank in NI with account 999888666
    When I submit a valid payment batch with messageId starting "MOCK-503"
    Then the outcome is OUTCOME_UNKNOWN
    And the payment status lookup fails

  @IBK-PAY-005
  Scenario: An invalid batch is refused before anything is sent
    Given the simulated bac bank in CR with account CR41010200009998886660
    When I submit a batch whose creditor accounts are not IBANs and whose amounts are zero
    Then the request is refused with these problems:
      | transfers[0].amount must be a positive decimal with at most 2 decimals |
      | transfers[0].creditorAccount: CR accounts must use iban                |
    And nothing was transmitted
