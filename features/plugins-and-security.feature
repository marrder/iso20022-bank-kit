Feature: Connector plugins and security
  As a platform team
  I want banks to be plugins that cannot be misused
  So that adding a bank never weakens the rules

  @IBK-PLG-001
  Scenario: A connector declares what it supports
    Given the bac connector
    Then it declares countries PA, CR, NI, HN, SV, GT
    And it declares statement formats CAMT053, MT940, MT942

  @IBK-PLG-002
  Scenario: Unsupported requests never reach the bank
    Given the simulated sim bank in US with account 999888666
    When I request an MT940 statement
    Then the request fails as UNSUPPORTED

  @IBK-SIM-006
  Scenario: The simulator rejects the reserved account
    Given the simulated bac bank in HN with account 000000000
    When I request the balance
    Then the bank rejects it with HTTP 422

  @IBK-SEC-002 @IBK-SEC-003
  Scenario: A live endpoint off the allowlist is refused without echoing secrets
    Given a live bac client allowing only "*.baccredomatic.com"
    When I open a session with endpoint "https://evil.example/api" and client secret "TOPSECRET-77"
    Then the session is refused because the endpoint is not allowed
    And the error does not contain "TOPSECRET-77"

  @IBK-SEC-001
  Scenario: MCP tools never take credentials as arguments
    Given an MCP server for the bac and sim connectors
    Then no tool argument looks like a credential

  @IBK-SEC-004
  Scenario: Hosts say whether they are simulated
    Given an MCP server for the bac and sim connectors
    Then the service info reports backend SIMULATED
