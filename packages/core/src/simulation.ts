// The domain contract of a simulated bank. @iso20022-bank-kit/simulator implements it; connectors
// translate their wire format to and from it, so simulated mode exercises their real codecs.
import type { AccountRef, PaymentBatch, PaymentStatusCode } from '@iso20022-bank-kit/iso20022';

export interface SimEntry {
  reference: string;
  endToEndId?: string;
  valueDate: string;
  bookingDate: string;
  creditDebit: 'CREDIT' | 'DEBIT';
  amount: string;
  /** 3-char SWIFT code, e.g. TRF. */
  transactionType: string;
  description: string;
}

export interface SimSignedAmount {
  amount: string;
  creditDebit: 'CREDIT' | 'DEBIT';
}

export type SimFailure = { kind: 'rejected'; httpStatus: number; reasonCode: string; description: string };

export type SimSubmitResult =
  | { kind: 'accepted'; eventTime: string }
  | { kind: 'duplicate'; httpStatus: number; reasonCode: string; description: string }
  | SimFailure
  /** The bank booked the payment but the response failed (SPEC IBK-SIM-002). */
  | { kind: 'server_error'; httpStatus: 500; booked: true }
  | { kind: 'unavailable'; httpStatus: 503; booked: false }
  | { kind: 'timeout'; booked: true };

export interface SimTransferStatus {
  endToEndId: string;
  status: Exclude<PaymentStatusCode, 'UNKNOWN'>;
  reasonCode: string;
  info: string;
  amount: string;
  currency: string;
  creditorName: string;
  creditorAccount: AccountRef;
  creditorBankCode?: string;
  creditorBankBic?: string;
}

export interface SimPaymentStatus {
  messageId: string;
  paymentInfoId: string;
  createdAt: string;
  requestedExecutionDate: string;
  groupStatus: Exclude<PaymentStatusCode, 'UNKNOWN'>;
  groupInfo: string;
  transfers: SimTransferStatus[];
}

export interface SimulationEngine {
  now(): Date;
  /** Monotonic id for message references. */
  nextId(): string;
  currencyFor(country: string): string;
  balance(country: string, account: AccountRef): { currency: string; available: SimSignedAmount } | SimFailure;
  statement(
    country: string,
    account: AccountRef,
    fromDate: string,
    toDate: string,
  ): { currency: string; opening: SimSignedAmount; closing: SimSignedAmount; entries: SimEntry[] } | SimFailure;
  submitPayment(batch: PaymentBatch): SimSubmitResult;
  paymentStatus(messageId: string): SimPaymentStatus | SimFailure;
}

export const isSimFailure = (x: unknown): x is SimFailure =>
  typeof x === 'object' && x !== null && (x as { kind?: string }).kind === 'rejected';
