// ISO 20022 / SWIFT code <-> domain enum mappings. Unknown codes map to UNKNOWN (SPEC IBK-MOD-002).
import { CURRENCIES } from './currencies.js';
import type {
  AccountType,
  BalanceType,
  CategoryPurpose,
  CreditDebit,
  EntryStatus,
  ErrorCategory,
  PaymentMethod,
  PaymentState,
  PaymentStatusCode,
  TransactionType,
} from './model.js';

export interface CodeMap<E extends string> {
  /** Domain enum values, in declaration order. */
  readonly values: readonly E[];
  toDomain(code: string | null | undefined): E | 'UNKNOWN';
  toIso(value: E): string;
}

export function codeMap<E extends string>(pairs: readonly (readonly [E, string])[]): CodeMap<E> {
  const toDomain = new Map(pairs.map(([e, iso]) => [iso, e]));
  const toIso = new Map(pairs);
  return {
    values: pairs.map(([e]) => e),
    toDomain: (code) => (code == null ? 'UNKNOWN' : (toDomain.get(String(code)) ?? 'UNKNOWN')),
    toIso: (value) => {
      const iso = toIso.get(value);
      if (iso === undefined) throw new RangeError(`No ISO code for ${value}`);
      return iso;
    },
  };
}

export const CreditDebitCodes = codeMap<Exclude<CreditDebit, 'UNKNOWN'>>([
  ['CREDIT', 'CRDT'],
  ['DEBIT', 'DBIT'],
]);

export const PaymentMethodCodes = codeMap<PaymentMethod>([
  ['TRANSFER', 'TRF'],
  ['CHECK', 'CHK'],
]);

export const CategoryPurposeCodes = codeMap<CategoryPurpose>([
  ['SUPPLIERS', 'SUPP'],
  ['PAYROLL', 'SALA'],
]);

export const AccountTypeCodes = codeMap<AccountType>([
  ['SAVINGS', 'SVGS'],
  ['CHECKING', 'CASH'],
  ['LOAN', 'LOAN'],
]);

/** BalanceType12Code */
export const BalanceTypeCodes = codeMap<Exclude<BalanceType, 'UNKNOWN'>>([
  ['OPENING_BOOKED', 'OPBD'],
  ['CLOSING_BOOKED', 'CLBD'],
  ['OPENING_AVAILABLE', 'OPAV'],
  ['CLOSING_AVAILABLE', 'CLAV'],
  ['INTERIM_AVAILABLE', 'ITAV'],
  ['INTERIM_BOOKED', 'ITBD'],
  ['FORWARD_AVAILABLE', 'FWAV'],
  ['EXPECTED', 'XPCD'],
]);

export const EntryStatusCodes = codeMap<Exclude<EntryStatus, 'UNKNOWN'>>([
  ['BOOKED', 'BOOK'],
  ['PENDING', 'PDNG'],
  ['INFORMATION', 'INFO'],
  ['FUTURE', 'FUTR'],
]);

/** ExternalPaymentTransactionStatus1Code (the subset with stable meaning). */
export const PaymentStatusCodes = codeMap<Exclude<PaymentStatusCode, 'UNKNOWN'>>([
  ['RECEIVED', 'RCVD'],
  ['PENDING', 'PDNG'],
  ['ACCEPTED_TECHNICAL_VALIDATION', 'ACTC'],
  ['ACCEPTED_CUSTOMER_PROFILE', 'ACCP'],
  ['ACCEPTED_FUNDS_CHECKED', 'ACFC'],
  ['ACCEPTED_WITH_CHANGE', 'ACWC'],
  ['ACCEPTED_WITHOUT_POSTING', 'ACWP'],
  ['ACCEPTED_SETTLEMENT_IN_PROCESS', 'ACSP'],
  ['ACCEPTED_SETTLEMENT_COMPLETED', 'ACSC'],
  ['ACCEPTED_CREDITOR_SETTLEMENT_COMPLETED', 'ACCC'],
  ['PARTIALLY_ACCEPTED', 'PART'],
  ['PARTIALLY_ACCEPTED_TECHNICAL', 'PATC'],
  ['REJECTED', 'RJCT'],
  ['CANCELLED', 'CANC'],
]);

/** Coarse lifecycle (SPEC IBK-STS-001). */
export function paymentState(status: PaymentStatusCode): PaymentState {
  switch (status) {
    case 'ACCEPTED_SETTLEMENT_COMPLETED':
    case 'ACCEPTED_CREDITOR_SETTLEMENT_COMPLETED':
      return 'COMPLETED';
    case 'REJECTED':
    case 'CANCELLED':
      return 'FAILED';
    case 'PARTIALLY_ACCEPTED':
    case 'PARTIALLY_ACCEPTED_TECHNICAL':
      return 'PARTIAL';
    case 'UNKNOWN':
      return 'UNKNOWN';
    default:
      return 'IN_PROGRESS';
  }
}

/** SWIFT transaction type identification codes (MT :61: subfield 6, camt BkTxCd proprietary domain). */
export const TransactionTypeCodes = codeMap<Exclude<TransactionType, 'UNKNOWN'>>([
  ['TRANSFER', 'TRF'],
  ['MISCELLANEOUS', 'MSC'],
  ['CHEQUE', 'CHK'],
  ['CHARGES', 'CHG'],
  ['COMMISSION', 'COM'],
  ['INTEREST', 'INT'],
  ['DIVIDEND', 'DIV'],
  ['DIRECT_DEBIT', 'DDT'],
  ['STANDING_ORDER', 'STO'],
  ['COLLECTION', 'COL'],
  ['CASH_LETTER', 'CLR'],
  ['CASH_MANAGEMENT', 'CMI'],
  ['FOREIGN_EXCHANGE', 'FEX'],
  ['LOAN_DEPOSIT', 'LDP'],
  ['RETURNED_ITEM', 'RTI'],
  ['BILL_OF_EXCHANGE', 'BOE'],
  ['BROKERAGE_FEE', 'BRF'],
  ['CORPORATE_ACTION', 'CAR'],
  ['SECURITIES', 'SEC'],
  ['TRAVELLERS_CHEQUE', 'TCK'],
  ['EQUIVALENT_AMOUNT', 'EQA'],
  ['REIMBURSEMENT', 'RIM'],
]);

/** Accepts "TRF" or the 4-char "NTRF" form (N/S/F prefix). */
export function transactionType(code: string | null | undefined): TransactionType {
  if (!code) return 'UNKNOWN';
  const core = code.length === 4 && /^[NSF]/.test(code) ? code.slice(1) : code;
  return TransactionTypeCodes.toDomain(core);
}

export function isIso4217(code: string): boolean {
  return (CURRENCIES as readonly string[]).includes(code);
}

/**
 * Normalises a reported currency to ISO 4217. `aliases` carries bank-specific non-ISO codes,
 * e.g. { LPS: 'HNL' } (SPEC IBK-MOD-003).
 */
export function normalizeCurrency(code: unknown, aliases: Readonly<Record<string, string>> = {}): string | null {
  if (code == null || code === '') return null;
  const upper = String(code).toUpperCase();
  return aliases[upper] ?? upper;
}

/** HTTP status -> ErrorCategory, following the common API gateway error catalogue. */
export function errorCategory(httpStatus: number): ErrorCategory {
  const map: Record<number, ErrorCategory> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    415: 'UNSUPPORTED_MEDIA_TYPE',
    422: 'VALIDATION_FAILED',
    429: 'RATE_LIMITED',
    500: 'INTERNAL_ERROR',
    503: 'SERVICE_UNAVAILABLE',
  };
  return map[httpStatus] ?? (httpStatus >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
}
