Feature: Payment status
  As an accounts-payable clerk
  I want a partial failure to look like a partial failure
  So that I re-pay only the transfers that failed

  @IBK-STS-002 @IBK-SIM-005
  Scenario Outline: One rejected transfer makes the batch PARTIAL
    Given the simulated <bank> bank in <country> with account <account>
    When I submit a payment batch whose first creditor is "REJECT Supplier"
    And I check the payment status twice
    Then the batch state is PARTIAL
    And the transfer states are FAILED, then COMPLETED for the rest

    Examples:
      | bank | country | account   |
      | bac  | HN      | 999888666 |
      | sim  | US      | 999888666 |
