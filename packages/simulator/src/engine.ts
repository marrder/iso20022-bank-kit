// Deterministic in-memory bank. Behaviour, including the scenario triggers, is specified in
// SPEC.md section 7 (IBK-SIM-*), so every connector's simulated mode behaves the same.
import type { SimEntry, SimFailure, SimPaymentStatus, SimSignedAmount, SimSubmitResult, SimulationEngine } from '@iso20022-bank-kit/core';
import type { AccountRef, PaymentBatch } from '@iso20022-bank-kit/iso20022';
import { isoDateTime, sumAmounts } from '@iso20022-bank-kit/iso20022';

/** Scenario triggers (SPEC IBK-SIM-002..007). */
export const SCENARIOS = {
  /** messageId prefix: payment is booked, then HTTP 500 is returned. */
  serverErrorAfterBooking: 'MOCK-500',
  /** messageId prefix: HTTP 503, nothing booked. */
  unavailable: 'MOCK-503',
  /** messageId prefix: payment is booked, then the call times out. */
  timeoutAfterBooking: 'MOCK-TIMEOUT',
  /** Account number the bank rejects (HTTP 422). */
  rejectedAccount: '000000000',
  /** Creditor name substring (case-insensitive): that transfer ends REJECTED. */
  rejectedCreditor: 'REJECT',
} as const;

/** admi.002 reason code for a duplicate MsgId. */
export const DUPLICATE_REASON_CODE = '1010';

interface Ledger {
  currency: string;
  /** cents */
  opening: bigint;
  entries: SimEntry[];
}

interface StoredPayment {
  batch: PaymentBatch;
  createdAt: string;
  statusCalls: number;
}

export interface SimulationOptions {
  /** Local currency per country; unknown countries use USD. */
  currencyByCountry?: Readonly<Record<string, string>>;
  now?: () => Date;
}

const cents = (amount: string) => {
  const [w = '0', f = ''] = amount.split('.');
  return BigInt(w) * 100n + BigInt(`${f}00`.slice(0, 2));
};
const fromCents = (c: bigint): SimSignedAmount => {
  const abs = c < 0n ? -c : c;
  return { amount: `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`, creditDebit: c < 0n ? 'DEBIT' : 'CREDIT' };
};
const signed = (e: SimEntry) => (e.creditDebit === 'CREDIT' ? 1n : -1n) * cents(e.amount);
const key = (a: AccountRef) => (a.iban ?? a.number ?? '').replace(/\s+/g, '').toUpperCase();
const reject = (httpStatus: number, reasonCode: string, description: string): SimFailure => ({
  kind: 'rejected',
  httpStatus,
  reasonCode,
  description,
});

/** Five seed entries booked the day before "now" on every account (SPEC IBK-SIM-001). */
export const SEED_ENTRIES: readonly Omit<SimEntry, 'valueDate' | 'bookingDate'>[] = [
  { reference: '390300598', creditDebit: 'DEBIT', amount: '221.19', transactionType: 'MSC', description: 'SUPPLIER INVOICE 1' },
  { reference: '390300599', creditDebit: 'DEBIT', amount: '430.50', transactionType: 'MSC', description: 'SUPPLIER INVOICE 2' },
  { reference: '390300601', creditDebit: 'CREDIT', amount: '305.22', transactionType: 'MSC', description: 'CUSTOMER RECEIPT 4' },
  { reference: '390300602', creditDebit: 'CREDIT', amount: '260.40', transactionType: 'MSC', description: 'CUSTOMER RECEIPT 5' },
  { reference: '8738', creditDebit: 'CREDIT', amount: '10.00', transactionType: 'TRF', description: 'API TEST CREDIT' },
];

export function createSimulationEngine(options: SimulationOptions = {}): SimulationEngine & { reset(): void } {
  const now = options.now ?? (() => new Date());
  let ledgers = new Map<string, Ledger>();
  let payments = new Map<string, StoredPayment>();
  let seq = 1000;

  const day = (offset: number) => new Date(now().getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const currencyFor = (country: string) => options.currencyByCountry?.[country] ?? 'USD';

  function ledger(country: string, account: AccountRef): Ledger {
    const k = key(account);
    let l = ledgers.get(k);
    if (!l) {
      // Opening balance derived from the account id, so values are stable across runs.
      const hash = [...k].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
      const d = day(-1);
      l = {
        currency: currencyFor(country),
        opening: BigInt(100_000 + (hash % 900_000)) * 100n + BigInt(hash % 100),
        entries: SEED_ENTRIES.map((e) => ({ ...e, valueDate: d, bookingDate: d })),
      };
      ledgers.set(k, l);
    }
    return l;
  }

  const total = (l: Ledger, entries: SimEntry[]) => entries.reduce((c, e) => c + signed(e), l.opening);

  return {
    now,
    nextId: () => String(seq++),
    currencyFor,
    reset() {
      ledgers = new Map();
      payments = new Map();
      seq = 1000;
    },

    balance(country, account) {
      if (account.number === SCENARIOS.rejectedAccount)
        return reject(422, 'MOCK-422', 'Account does not exist or does not belong to this client (simulated)');
      const l = ledger(country, account);
      return { currency: l.currency, available: fromCents(total(l, l.entries)) };
    },

    statement(country, account, fromDate, toDate) {
      if (account.number === SCENARIOS.rejectedAccount)
        return reject(422, 'MOCK-422', 'Account does not exist or does not belong to this client (simulated)');
      const l = ledger(country, account);
      const before = l.entries.filter((e) => e.bookingDate < fromDate);
      const inRange = l.entries.filter((e) => e.bookingDate >= fromDate && e.bookingDate <= toDate);
      return {
        currency: l.currency,
        opening: fromCents(total(l, before)),
        closing: fromCents(total(l, [...before, ...inRange])),
        entries: inRange,
      };
    },

    submitPayment(batch): SimSubmitResult {
      const id = batch.messageId;
      if (payments.has(id))
        return { kind: 'duplicate', httpStatus: 409, reasonCode: DUPLICATE_REASON_CODE, description: 'Duplicate message identification' };
      if (id.startsWith(SCENARIOS.unavailable)) return { kind: 'unavailable', httpStatus: 503, booked: false };
      if (batch.debtorAccount.number === SCENARIOS.rejectedAccount) {
        return {
          kind: 'rejected',
          httpStatus: 422,
          reasonCode: 'MOCK-422',
          description: 'Debtor account does not exist or does not belong to this client (simulated)',
        };
      }
      payments.set(id, { batch, createdAt: isoDateTime(now()), statusCalls: 0 });
      const l = ledger(batch.country, batch.debtorAccount);
      for (const t of batch.transfers) {
        if (t.creditor.name.toUpperCase().includes(SCENARIOS.rejectedCreditor)) continue;
        l.entries.push({
          reference: String(seq++),
          endToEndId: t.endToEndId,
          valueDate: day(0),
          bookingDate: day(0),
          creditDebit: 'DEBIT',
          amount: sumAmounts([t.amount]),
          transactionType: 'TRF',
          description: `Payment ${t.creditor.name}`.slice(0, 35),
        });
      }
      if (id.startsWith(SCENARIOS.serverErrorAfterBooking)) return { kind: 'server_error', httpStatus: 500, booked: true };
      if (id.startsWith(SCENARIOS.timeoutAfterBooking)) return { kind: 'timeout', booked: true };
      return { kind: 'accepted', eventTime: isoDateTime(now()) };
    },

    paymentStatus(messageId): SimPaymentStatus | SimFailure {
      const p = payments.get(messageId);
      if (!p) return reject(404, 'MOCK-404', 'No payment with this message identification (simulated)');
      // First query: technically accepted. Later queries: final outcome (SPEC IBK-SIM-004).
      const final = p.statusCalls++ > 0;
      const transfers = p.batch.transfers.map((t) => {
        const rejected = final && t.creditor.name.toUpperCase().includes(SCENARIOS.rejectedCreditor);
        return {
          endToEndId: t.endToEndId,
          status: rejected
            ? ('REJECTED' as const)
            : final
              ? ('ACCEPTED_SETTLEMENT_COMPLETED' as const)
              : ('ACCEPTED_TECHNICAL_VALIDATION' as const),
          reasonCode: rejected ? 'MOCK' : '0',
          info: rejected ? 'Rejected by simulated scenario' : final ? 'Transaction applied' : 'Transaction received',
          amount: sumAmounts([t.amount]),
          currency: t.currency,
          creditorName: t.creditor.name,
          creditorAccount: t.creditorAccount,
          ...(t.creditorBankCode ? { creditorBankCode: t.creditorBankCode } : {}),
          ...(t.creditorBankBic ? { creditorBankBic: t.creditorBankBic } : {}),
        };
      });
      const anyRejected = transfers.some((t) => t.status === 'REJECTED');
      return {
        messageId,
        paymentInfoId: p.batch.paymentInfoId ?? messageId,
        createdAt: p.createdAt,
        requestedExecutionDate: p.batch.requestedExecutionDate,
        groupStatus: !final ? 'RECEIVED' : anyRejected ? 'REJECTED' : 'ACCEPTED_SETTLEMENT_COMPLETED',
        groupInfo: !final ? 'Payment instruction received' : anyRejected ? 'Partial or total rejection' : 'Payment applied',
        transfers,
      };
    },
  };
}
