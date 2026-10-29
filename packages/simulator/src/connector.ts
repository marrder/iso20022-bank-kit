// A connector that talks to the simulation engine directly (no wire format). Useful for building
// apps before you have a bank, and as the reference implementation for the conformance suite.

import type { BankConnector, CountryProfile, SimFailure } from '@iso20022-bank-kit/core';
import {
  BankError,
  classifyPaymentHttp,
  defineConnector,
  isSimFailure,
  OUTCOME_UNKNOWN_GUIDANCE,
  TransportError,
} from '@iso20022-bank-kit/core';
import type { PaymentStatusReport, StatusCount } from '@iso20022-bank-kit/iso20022';
import { deriveState, errorCategory, paymentState, sumAmounts } from '@iso20022-bank-kit/iso20022';

/** Fictional banks in four countries. BICs use the reserved-looking "SIMB" prefix. */
export const SIMULATED_COUNTRIES: readonly CountryProfile[] = [
  {
    code: 'US',
    name: 'United States',
    bankBic: 'SIMBUS33',
    localCurrency: 'USD',
    requiresIban: false,
    intrabankClearingCode: '000000001',
    utcOffsetMinutes: -300,
  },
  {
    code: 'GB',
    name: 'United Kingdom',
    bankBic: 'SIMBGB2L',
    localCurrency: 'GBP',
    requiresIban: true,
    intrabankClearingCode: '000001',
    utcOffsetMinutes: 0,
  },
  {
    code: 'DE',
    name: 'Germany',
    bankBic: 'SIMBDEFF',
    localCurrency: 'EUR',
    requiresIban: true,
    intrabankClearingCode: '10000000',
    utcOffsetMinutes: 60,
  },
  {
    code: 'MX',
    name: 'México',
    bankBic: 'SIMBMXMM',
    localCurrency: 'MXN',
    requiresIban: false,
    intrabankClearingCode: '001',
    utcOffsetMinutes: -360,
  },
];

const fail = (f: SimFailure) =>
  new BankError(errorCategory(f.httpStatus), f.description, { httpStatus: f.httpStatus, bankCode: f.reasonCode });

export function createSimulatedConnector(
  options: { id?: string; name?: string; countries?: readonly CountryProfile[] } = {},
): BankConnector {
  const countries = options.countries ?? SIMULATED_COUNTRIES;
  return defineConnector({
    id: options.id ?? 'sim',
    name: options.name ?? 'Simulated Bank',
    version: '0.1.0',
    description: 'In-process simulated bank with deterministic data and failure scenarios. Never moves money.',
    countries,
    capabilities: {
      balance: true,
      statementFormats: ['CAMT053'],
      paymentInitiation: true,
      paymentStatus: true,
      routes: ['INTRABANK', 'DOMESTIC_CLEARING', 'CROSS_BORDER'],
    },
    connectionFields: [],
    open(_connection, ctx) {
      const sim = ctx.simulation;
      if (!sim) throw new TypeError('The simulated connector needs a simulation engine (backend "simulated")');
      return {
        async getBalance({ country, account }) {
          const r = sim.balance(country, account);
          if (isSimFailure(r)) throw fail(r);
          const now = sim.now().toISOString();
          return {
            country,
            bankMessageId: sim.nextId(),
            reportId: sim.nextId(),
            createdAt: now,
            account: { number: account.number ?? null, iban: account.iban ?? null, currency: r.currency },
            balances: [
              {
                type: 'INTERIM_AVAILABLE',
                typeCode: 'ITAV',
                creditDebit: r.available.creditDebit,
                amount: r.available.amount,
                currency: r.currency,
                date: now.slice(0, 10),
                dateTime: now,
              },
            ],
          };
        },
        async getStatement({ country, account, format, fromDate, toDate }) {
          const to = toDate ?? fromDate;
          const r = sim.statement(country, account, fromDate, to);
          if (isSimFailure(r)) throw fail(r);
          return {
            format,
            country,
            bankMessageId: sim.nextId(),
            statementId: sim.nextId(),
            sequenceNumber: null,
            page: 1,
            lastPage: true,
            createdAt: sim.now().toISOString(),
            fromDateTime: `${fromDate}T00:00:00Z`,
            toDateTime: `${to}T23:59:59Z`,
            account: { number: account.number ?? null, iban: account.iban ?? null, currency: r.currency },
            balances: [
              {
                type: 'OPENING_BOOKED',
                typeCode: 'OPBD',
                creditDebit: r.opening.creditDebit,
                amount: r.opening.amount,
                currency: r.currency,
                date: fromDate,
                dateTime: null,
              },
              {
                type: 'CLOSING_BOOKED',
                typeCode: 'CLBD',
                creditDebit: r.closing.creditDebit,
                amount: r.closing.amount,
                currency: r.currency,
                date: to,
                dateTime: null,
              },
            ],
            entries: r.entries.map((e) => ({
              reference: e.reference,
              bankReference: null,
              endToEndId: e.endToEndId ?? null,
              creditDebit: e.creditDebit,
              reversal: false,
              status: 'BOOKED',
              statusCode: 'BOOK',
              bookingDate: e.bookingDate,
              valueDate: e.valueDate,
              transactionType: e.transactionType === 'TRF' ? 'TRANSFER' : 'MISCELLANEOUS',
              transactionTypeCode: e.transactionType,
              description: e.description,
              amount: e.amount,
              currency: r.currency,
            })),
            interim: null,
            information: null,
            raw: null,
          };
        },
        async getPaymentStatus({ country, messageId }): Promise<PaymentStatusReport> {
          const r = sim.paymentStatus(messageId);
          if (isSimFailure(r)) throw fail(r);
          const counts = (): StatusCount[] => {
            const by = new Map<string, typeof r.transfers>();
            for (const t of r.transfers) by.set(t.status, [...(by.get(t.status) ?? []), t]);
            return [...by.entries()].map(([s, xs]) => {
              const status = s as (typeof r.transfers)[number]['status'];
              return {
                status,
                statusCode: null,
                state: paymentState(status),
                count: xs.length,
                controlSum: sumAmounts(xs.map((x) => x.amount)),
              };
            });
          };
          const c = counts();
          const level = { status: r.groupStatus, statusCode: null, state: paymentState(r.groupStatus) };
          return deriveState(
            {
              country,
              messageId,
              reportId: sim.nextId(),
              bankMessageId: null,
              createdAt: sim.now().toISOString(),
              originalCreatedAt: r.createdAt,
              numberOfTransactions: r.transfers.length,
              controlSum: sumAmounts(r.transfers.map((t) => t.amount)),
              ...level,
              statusInfo: r.groupInfo,
              countsByStatus: c,
              paymentInfos: [
                deriveState(
                  {
                    paymentInfoId: r.paymentInfoId,
                    ...level,
                    statusInfo: r.groupInfo,
                    countsByStatus: c,
                    transactions: r.transfers.map((t) => ({
                      endToEndId: t.endToEndId,
                      status: t.status,
                      statusCode: null,
                      state: paymentState(t.status),
                      reasonCode: t.reasonCode,
                      statusInfo: t.info,
                      requestedExecutionDate: r.requestedExecutionDate,
                      creditorName: t.creditorName,
                      creditorAccount: t.creditorAccount,
                      creditorBankCode: t.creditorBankCode ?? null,
                      creditorBankBic: t.creditorBankBic ?? null,
                      amount: t.amount,
                      currency: t.currency,
                    })),
                  },
                  c,
                ),
              ],
            },
            c,
          );
        },
        async initiatePayment(batch) {
          const r = sim.submitPayment(batch);
          switch (r.kind) {
            case 'accepted':
              return {
                result: 'SUBMITTED',
                messageId: batch.messageId,
                country: batch.country,
                eventCode: 'RCVD',
                description: 'Received',
                eventTime: r.eventTime,
              };
            case 'timeout':
              throw new TransportError('TIMEOUT', 'Timed out (simulated)');
            case 'duplicate':
            case 'rejected':
              return (
                classifyPaymentHttp(
                  batch.messageId,
                  {
                    status: r.httpStatus,
                    reject: {
                      code: r.kind === 'duplicate' ? 'DUPLICATE_MESSAGE_ID' : 'UNKNOWN',
                      bankCode: r.reasonCode,
                      description: r.description,
                    },
                  },
                  errorCategory,
                ) ?? {
                  result: 'OUTCOME_UNKNOWN',
                  messageId: batch.messageId,
                  category: 'INTERNAL_ERROR',
                  httpStatus: null,
                  detail: null,
                  guidance: OUTCOME_UNKNOWN_GUIDANCE,
                }
              );
            default:
              return {
                result: 'OUTCOME_UNKNOWN',
                messageId: batch.messageId,
                category: errorCategory(r.httpStatus),
                httpStatus: r.httpStatus,
                detail: null,
                guidance: OUTCOME_UNKNOWN_GUIDANCE,
              };
          }
        },
      };
    },
  });
}
