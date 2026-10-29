// Bank-agnostic domain model. Names follow ISO 20022 business components where one exists;
// every normalised code keeps the raw value it came from (SPEC IBK-MOD-002).

/** Decimal amount as a string, never a binary float (SPEC IBK-MOD-001). */
export type Decimal = string;
/** ISO 3166-1 alpha-2 country code. */
export type CountryCode = string;
/** ISO 4217 currency code. */
export type CurrencyCode = string;
/** YYYY-MM-DD */
export type IsoDate = string;
/** ISO 8601 date-time, with offset when the bank provides one. */
export type IsoDateTime = string;

export type CreditDebit = 'CREDIT' | 'DEBIT' | 'UNKNOWN';

/** Exactly one of `number` or `iban`. */
export interface AccountRef {
  number?: string;
  iban?: string;
}

export interface Account {
  number: string | null;
  iban: string | null;
  /** ISO 4217 code after normalisation (null when not reported). */
  currency: CurrencyCode | null;
}

export interface Money {
  amount: Decimal | null;
  currency: CurrencyCode | null;
}

export type BalanceType =
  | 'OPENING_BOOKED'
  | 'CLOSING_BOOKED'
  | 'OPENING_AVAILABLE'
  | 'CLOSING_AVAILABLE'
  | 'INTERIM_AVAILABLE'
  | 'INTERIM_BOOKED'
  | 'FORWARD_AVAILABLE'
  | 'EXPECTED'
  | 'UNKNOWN';

export interface Balance extends Money {
  type: BalanceType;
  /** Raw ISO code, e.g. ITAV. */
  typeCode: string | null;
  creditDebit: CreditDebit;
  date: IsoDate | null;
  dateTime: IsoDateTime | null;
}

export interface BalanceReport {
  country: CountryCode | null;
  bankMessageId: string | null;
  reportId: string | null;
  createdAt: IsoDateTime | null;
  account: Account;
  balances: Balance[];
}

export type StatementFormat = 'CAMT053' | 'MT940' | 'MT942';

export type EntryStatus = 'BOOKED' | 'PENDING' | 'INFORMATION' | 'FUTURE' | 'UNKNOWN';

export type TransactionType =
  | 'TRANSFER'
  | 'MISCELLANEOUS'
  | 'CHEQUE'
  | 'CHARGES'
  | 'COMMISSION'
  | 'INTEREST'
  | 'DIVIDEND'
  | 'DIRECT_DEBIT'
  | 'STANDING_ORDER'
  | 'COLLECTION'
  | 'CASH_LETTER'
  | 'CASH_MANAGEMENT'
  | 'FOREIGN_EXCHANGE'
  | 'LOAN_DEPOSIT'
  | 'RETURNED_ITEM'
  | 'BILL_OF_EXCHANGE'
  | 'BROKERAGE_FEE'
  | 'CORPORATE_ACTION'
  | 'SECURITIES'
  | 'TRAVELLERS_CHEQUE'
  | 'EQUIVALENT_AMOUNT'
  | 'REIMBURSEMENT'
  | 'UNKNOWN';

export interface Entry extends Money {
  reference: string | null;
  bankReference: string | null;
  endToEndId: string | null;
  creditDebit: CreditDebit;
  reversal: boolean;
  status: EntryStatus;
  statusCode: string | null;
  bookingDate: IsoDate | null;
  valueDate: IsoDate | null;
  transactionType: TransactionType;
  transactionTypeCode: string | null;
  description: string | null;
}

export interface TransactionSummary extends Money {
  count: number;
}

export interface Statement {
  format: StatementFormat;
  country: CountryCode | null;
  bankMessageId: string | null;
  statementId: string | null;
  sequenceNumber: string | null;
  page: number;
  lastPage: boolean;
  createdAt: IsoDateTime | null;
  fromDateTime: IsoDateTime | null;
  toDateTime: IsoDateTime | null;
  account: Account;
  balances: Balance[];
  entries: Entry[];
  /** MT942 only. */
  interim: { floorLimit: Money | null; debits: TransactionSummary | null; credits: TransactionSummary | null } | null;
  information: string | null;
  /** Original SWIFT FIN text for MT formats. */
  raw: string | null;
}

export type PaymentStatusCode =
  | 'RECEIVED'
  | 'PENDING'
  | 'ACCEPTED_TECHNICAL_VALIDATION'
  | 'ACCEPTED_CUSTOMER_PROFILE'
  | 'ACCEPTED_FUNDS_CHECKED'
  | 'ACCEPTED_WITH_CHANGE'
  | 'ACCEPTED_WITHOUT_POSTING'
  | 'ACCEPTED_SETTLEMENT_IN_PROCESS'
  | 'ACCEPTED_SETTLEMENT_COMPLETED'
  | 'ACCEPTED_CREDITOR_SETTLEMENT_COMPLETED'
  | 'PARTIALLY_ACCEPTED'
  | 'PARTIALLY_ACCEPTED_TECHNICAL'
  | 'REJECTED'
  | 'CANCELLED'
  | 'UNKNOWN';

export type PaymentState = 'IN_PROGRESS' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'UNKNOWN';

export interface StatusFields {
  status: PaymentStatusCode;
  statusCode: string | null;
  state: PaymentState;
}

export interface StatusCount extends StatusFields {
  count: number;
  controlSum: Decimal | null;
}

export interface TransferStatus extends StatusFields, Money {
  endToEndId: string | null;
  reasonCode: string | null;
  statusInfo: string | null;
  requestedExecutionDate: IsoDate | null;
  creditorName: string | null;
  creditorAccount: AccountRef;
  creditorBankCode: string | null;
  creditorBankBic: string | null;
}

export interface PaymentInfoStatus extends StatusFields {
  paymentInfoId: string | null;
  statusInfo: string | null;
  countsByStatus: StatusCount[];
  transactions: TransferStatus[];
}

export interface PaymentStatusReport extends StatusFields {
  country: CountryCode | null;
  messageId: string | null;
  reportId: string | null;
  bankMessageId: string | null;
  createdAt: IsoDateTime | null;
  originalCreatedAt: IsoDateTime | null;
  numberOfTransactions: number;
  controlSum: Decimal | null;
  statusInfo: string | null;
  countsByStatus: StatusCount[];
  paymentInfos: PaymentInfoStatus[];
}

// ------------------------------------------------------------------ payment initiation

/** How a transfer reaches the creditor. */
export type TransferRoute =
  /** Same bank, same country (book transfer). */
  | 'INTRABANK'
  /** Another bank in the same country through the local clearing system (ACH, SINPE, ...). */
  | 'DOMESTIC_CLEARING'
  /** Cross-border wire, identified by creditor bank BIC. */
  | 'CROSS_BORDER';

export type AccountType = 'SAVINGS' | 'CHECKING' | 'LOAN';
export type PaymentMethod = 'TRANSFER' | 'CHECK';
export type CategoryPurpose = 'SUPPLIERS' | 'PAYROLL';

export interface PostalAddress {
  town: string;
  country: CountryCode;
  line: string;
}

export interface Transfer {
  endToEndId: string;
  route: TransferRoute;
  amount: Decimal;
  currency: CurrencyCode;
  creditor: { name: string; id?: string; address?: PostalAddress };
  creditorAccount: AccountRef;
  creditorAccountType?: AccountType;
  /** Local clearing member id. */
  creditorBankCode?: string;
  creditorBankBic?: string;
  /** Proprietary purpose code (Purp/Prtry). */
  purposeCode?: string;
  /** Remittance references (RfrdDocInf/Nb). */
  references?: string[];
}

export interface PaymentBatch {
  /** GrpHdr/MsgId: unique per client, max 35 chars, and the idempotency key (SPEC IBK-PAY-003). */
  messageId: string;
  paymentInfoId?: string;
  country: CountryCode;
  debtorName: string;
  debtorAccount: AccountRef;
  requestedExecutionDate: IsoDate;
  method?: PaymentMethod;
  purpose?: CategoryPurpose;
  transfers: Transfer[];
}

export type ErrorCategory =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'TIMEOUT'
  | 'NETWORK';

export type BankErrorCode = 'DUPLICATE_MESSAGE_ID' | 'UNKNOWN';

/** The three possible results of initiating a payment (SPEC IBK-PAY-002). */
export type PaymentOutcome =
  | {
      result: 'SUBMITTED';
      messageId: string;
      country: CountryCode | null;
      eventCode: string | null;
      description: string | null;
      eventTime: IsoDateTime | null;
    }
  | {
      result: 'REJECTED';
      messageId: string;
      category: ErrorCategory;
      httpStatus: number | null;
      code: BankErrorCode;
      bankCode: string | null;
      description: string | null;
      duplicate: boolean;
    }
  | {
      result: 'OUTCOME_UNKNOWN';
      messageId: string;
      category: ErrorCategory;
      httpStatus: number | null;
      detail: string | null;
      guidance: string;
    };
