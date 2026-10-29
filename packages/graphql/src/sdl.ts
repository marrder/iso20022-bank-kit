// Builds the SDL from the installed connectors. Static parts mirror the domain model.
import type { BankConnector } from '@iso20022-bank-kit/core';
import {
  AccountTypeCodes,
  BalanceTypeCodes,
  CategoryPurposeCodes,
  CURRENCIES,
  EntryStatusCodes,
  PaymentMethodCodes,
  PaymentStatusCodes,
  TransactionTypeCodes,
} from '@iso20022-bank-kit/iso20022';

const desc = (s: string) => `"""\n${s.replaceAll('"""', '\\"""')}\n"""`;
const pascal = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
const enumOf = (name: string, values: readonly string[], description: string, valueDocs: (v: string) => string | null = () => null) =>
  `${desc(description)}\nenum ${name} {\n${values.map((v) => (valueDocs(v) ? `  "${valueDocs(v)}"\n  ${v}` : `  ${v}`)).join('\n')}\n}`;
const iso = (map: { toIso(v: string): string }) => (v: string) =>
  v === 'UNKNOWN' ? 'Code with no mapping; see the raw code field' : map.toIso(v);

export const connectionInputName = (c: BankConnector) => `${pascal(c.id)}ConnectionInput`;
export const connectionEnumName = (c: BankConnector, key: string) => `${pascal(c.id)}${pascal(key)}`;

function connectionInput(c: BankConnector): string {
  const enums = c.connectionFields
    .filter((f) => f.values)
    .map((f) => enumOf(connectionEnumName(c, f.key), f.values ?? [], `${c.name}: ${f.description}`));
  const fields = c.connectionFields.map((f) => {
    const type = f.values ? connectionEnumName(c, f.key) : 'String';
    const notes = [
      f.description,
      f.required ? 'Required when the backend is live.' : null,
      f.secret ? 'Secret: never logged or returned.' : null,
      f.default ? `Default: ${f.default}.` : null,
    ]
      .filter(Boolean)
      .join(' ');
    return `  "${notes.replaceAll('"', "'")}"\n  ${f.key}: ${type}`;
  });
  if (!fields.length) return '';
  return [
    ...enums,
    `${desc(`Credentials and endpoint for ${c.name}. Pass it as a variable, never inline.`)}\ninput ${connectionInputName(c)} {\n${fields.join('\n')}\n}`,
  ].join('\n\n');
}

export function buildSdl(connectors: readonly BankConnector[]): string {
  const countries = [...new Set(connectors.flatMap((c) => c.countries.map((p) => p.code)))].sort();
  const countryNames = new Map(connectors.flatMap((c) => c.countries.map((p) => [p.code, p.name] as const)));
  const root = (kind: 'Query' | 'Mutation') =>
    connectors
      .map((c) => {
        const arg = c.connectionFields.length ? `(connection: ${connectionInputName(c)})` : '';
        return `  ${desc(`${c.name} (${kind === 'Query' ? 'reads' : 'writes'}). ${c.description}`)}\n  ${c.id}${arg}: Bank${kind}!`;
      })
      .join('\n');

  return `
${desc('Bank-agnostic GraphQL API over ISO 20022 connectors. Each installed bank connector is a top-level field taking its own connection.')}
schema { query: Query mutation: Mutation }

"Calendar date, YYYY-MM-DD."
scalar Date
"ISO 8601 date-time."
scalar DateTime
"Time of day, HH:MM:SS[.sss]."
scalar Time
"Decimal amount as a string; never a float (SPEC IBK-MOD-001)."
scalar Decimal

type Query {
  "Backend (SIMULATED or LIVE) and version (SPEC IBK-SEC-004)."
  serviceInfo: ServiceInfo!
  "Installed connectors with their countries and capabilities."
  connectors: [ConnectorInfo!]!
${root('Query')}
}

type Mutation {
${root('Mutation')}
}

${connectors.map(connectionInput).filter(Boolean).join('\n\n')}

${enumOf('Country', countries, 'Countries served by the installed connectors (ISO 3166-1 alpha-2).', (c) => countryNames.get(c) ?? null)}

${enumOf('Currency', [...CURRENCIES, 'UNKNOWN'], 'ISO 4217 currency. UNKNOWN appears only in responses; the raw code is in currencyCode.')}

${enumOf('Backend', ['SIMULATED', 'LIVE'], 'Which backend this deployment serves.')}
${enumOf('StatementFormat', ['CAMT053', 'MT940', 'MT942'], 'Statement formats. All normalise to the same Statement shape (SPEC IBK-STM-001).', (v) => ({ CAMT053: 'ISO 20022 camt.053.001.08', MT940: 'SWIFT MT940 customer statement', MT942: 'SWIFT MT942 interim report' })[v] ?? null)}
${enumOf('CreditDebit', ['CREDIT', 'DEBIT', 'UNKNOWN'], 'CdtDbtInd', (v) => ({ CREDIT: 'CRDT', DEBIT: 'DBIT' })[v] ?? null)}
${enumOf('BalanceType', [...BalanceTypeCodes.values, 'UNKNOWN'], 'ISO 20022 BalanceType12Code.', iso(BalanceTypeCodes))}
${enumOf('EntryStatus', [...EntryStatusCodes.values, 'UNKNOWN'], 'Entry status.', iso(EntryStatusCodes))}
${enumOf('TransactionType', [...TransactionTypeCodes.values, 'UNKNOWN'], 'SWIFT transaction type identification code.', iso(TransactionTypeCodes))}
${enumOf('PaymentStatusCode', [...PaymentStatusCodes.values, 'UNKNOWN'], 'ISO 20022 ExternalPaymentTransactionStatus1Code.', iso(PaymentStatusCodes))}
${enumOf('PaymentState', ['IN_PROGRESS', 'COMPLETED', 'PARTIAL', 'FAILED', 'UNKNOWN'], 'Coarse lifecycle (SPEC IBK-STS-001).')}
${enumOf('TransferRoute', ['INTRABANK', 'DOMESTIC_CLEARING', 'CROSS_BORDER'], 'How a transfer reaches the creditor.', (v) => ({ INTRABANK: 'Same bank, same country', DOMESTIC_CLEARING: 'Other local bank via ACH/clearing; needs creditorBankCode', CROSS_BORDER: 'Cross-border wire; needs creditorBankBic and creditor.address' })[v] ?? null)}
${enumOf('AccountType', AccountTypeCodes.values, 'Creditor account type (CdtrAcct/Tp/Cd).', iso(AccountTypeCodes))}
${enumOf('PaymentMethod', PaymentMethodCodes.values, 'PmtMtd', iso(PaymentMethodCodes))}
${enumOf('CategoryPurpose', CategoryPurposeCodes.values, 'CtgyPurp/Cd', iso(CategoryPurposeCodes))}
${enumOf('ErrorCategory', ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'UNSUPPORTED_MEDIA_TYPE', 'VALIDATION_FAILED', 'RATE_LIMITED', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'NETWORK'], 'Category of a failure.')}
${enumOf('BankErrorCode', ['DUPLICATE_MESSAGE_ID', 'UNKNOWN'], 'admi.002 reasons with known meaning.')}

type ServiceInfo { backend: Backend! version: String! }

type CountryInfo {
  code: Country!
  name: String!
  bankBic: String!
  localCurrency: Currency!
  requiresIban: Boolean!
  intrabankClearingCode: String
  sampleClearingCodes: [ClearingCode!]!
}
type ClearingCode { label: String! code: String! }
type Capabilities { balance: Boolean! statementFormats: [StatementFormat!]! paymentInitiation: Boolean! paymentStatus: Boolean! routes: [TransferRoute!]! }
type ConnectorInfo { id: String! name: String! version: String! description: String! countries: [CountryInfo!]! capabilities: Capabilities! }

"Exactly one of number or iban."
input AccountInput @oneOf { number: String iban: String }
type Account { number: String iban: String currency: Currency currencyCode: String }
type Money { amount: Decimal currency: Currency currencyCode: String }
type Balance { type: BalanceType! typeCode: String creditDebit: CreditDebit! amount: Decimal currency: Currency currencyCode: String date: Date dateTime: DateTime }
type BalanceReport { country: Country bankMessageId: String reportId: String createdAt: DateTime account: Account! balances: [Balance!]! }
type Entry {
  reference: String bankReference: String endToEndId: String creditDebit: CreditDebit! reversal: Boolean! status: EntryStatus! statusCode: String
  bookingDate: Date valueDate: Date transactionType: TransactionType! transactionTypeCode: String description: String amount: Decimal currency: Currency currencyCode: String
}
type TransactionSummary { count: Int! amount: Decimal currency: Currency currencyCode: String }
type InterimReport { floorLimit: Money debits: TransactionSummary credits: TransactionSummary }
type Statement {
  format: StatementFormat! country: Country bankMessageId: String statementId: String sequenceNumber: String page: Int! lastPage: Boolean!
  createdAt: DateTime fromDateTime: DateTime toDateTime: DateTime account: Account! balances: [Balance!]!
  openingBalance: Balance closingBalance: Balance
  entries(creditDebit: CreditDebit): [Entry!]!
  interim: InterimReport information: String
  "Decoded SWIFT FIN text for MT formats."
  raw: String
}
type StatusCount { count: Int! controlSum: Decimal status: PaymentStatusCode! statusCode: String state: PaymentState! }
type TransferStatus {
  endToEndId: String status: PaymentStatusCode! statusCode: String state: PaymentState! reasonCode: String statusInfo: String requestedExecutionDate: Date
  creditorName: String creditorAccount: Account creditorBankCode: String creditorBankBic: String amount: Decimal currency: Currency currencyCode: String
}
type PaymentInfoStatus { paymentInfoId: String status: PaymentStatusCode! statusCode: String state: PaymentState! statusInfo: String countsByStatus: [StatusCount!]! transactions(state: PaymentState): [TransferStatus!]! }
type PaymentStatusReport {
  country: Country messageId: String reportId: String bankMessageId: String createdAt: DateTime originalCreatedAt: DateTime numberOfTransactions: Int! controlSum: Decimal
  status: PaymentStatusCode! statusCode: String state: PaymentState! statusInfo: String countsByStatus: [StatusCount!]! paymentInfos: [PaymentInfoStatus!]!
}

type BankQuery {
  "Available balance (camt.060 -> camt.052)."
  balance(country: Country!, account: AccountInput!): BalanceReport!
  "Statement in any supported format, normalised (camt.060 -> camt.053 / MT940 / MT942)."
  statement(country: Country!, account: AccountInput!, format: StatementFormat = CAMT053, fromDate: Date!, toDate: Date, fromTime: Time, toTime: Time): Statement!
  "Batch status by messageId (tsmt.038 -> pain.002)."
  paymentStatus(country: Country!, messageId: ID!): PaymentStatusReport!
}

type BankMutation {
  ${desc('Submits a payment batch (pain.001). Never retried automatically. On PaymentOutcomeUnknown check paymentStatus first; if you resend, reuse the same messageId (SPEC IBK-PAY-001..003).')}
  initiatePayment(input: PaymentBatchInput!): InitiatePaymentResult!
}

input PostalAddressInput { town: String! "ISO 3166-1 alpha-2" country: String! line: String! }
input CreditorInput { name: String! id: String address: PostalAddressInput }
input TransferInput {
  endToEndId: ID! route: TransferRoute! amount: Decimal! currency: Currency! creditor: CreditorInput! creditorAccount: AccountInput!
  creditorAccountType: AccountType creditorBankCode: String creditorBankBic: String purposeCode: String references: [String!]
}
input PaymentBatchInput {
  "Unique per client, max 35 chars; the idempotency key."
  messageId: ID!
  paymentInfoId: ID country: Country! debtorName: String! debtorAccount: AccountInput! requestedExecutionDate: Date!
  method: PaymentMethod = TRANSFER purpose: CategoryPurpose = SUPPLIERS transfers: [TransferInput!]!
}

union InitiatePaymentResult = PaymentSubmitted | PaymentRejected | PaymentOutcomeUnknown
"Accepted for processing. Poll paymentStatus."
type PaymentSubmitted { messageId: ID! country: Country eventCode: String description: String eventTime: DateTime }
"Definitely not processed. duplicate=true means this messageId already exists."
type PaymentRejected { messageId: ID! category: ErrorCategory! httpStatus: Int code: BankErrorCode! bankCode: String description: String duplicate: Boolean! }
"The debit MAY have happened. Check paymentStatus before acting; never resend with a different messageId."
type PaymentOutcomeUnknown { messageId: ID! category: ErrorCategory! httpStatus: Int detail: String guidance: String! }
`;
}
