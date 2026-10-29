// Synthetic test data builders. All values are fictional; nothing here comes from a bank.

import type { BankConnector } from '@iso20022-bank-kit/core';
import type { PaymentBatch, Transfer } from '@iso20022-bank-kit/iso20022';
import { createSimulationEngine, type SimulationOptions } from './engine.js';

let counter = 0;
/** Unique, max-35-char message id. */
export const uniqueMessageId = (prefix = 'TEST') =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`.slice(0, 35).toUpperCase();

export const today = (now = new Date()) => now.toISOString().slice(0, 10);
export const yesterday = (now = new Date()) => new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

export function sampleTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    endToEndId: overrides.endToEndId ?? uniqueMessageId('E2E'),
    route: 'INTRABANK',
    amount: '100.00',
    currency: 'USD',
    creditor: { name: 'Example Supplier' },
    creditorAccount: { number: '123456789' },
    ...overrides,
  };
}

/** One batch with all three routes, valid for a connector that serves `country`. */
export function sampleBatch(country: string, currency: string, overrides: Partial<PaymentBatch> = {}): PaymentBatch {
  const messageId = overrides.messageId ?? uniqueMessageId();
  return {
    messageId,
    country,
    debtorName: 'Example Corp',
    debtorAccount: { number: '999888666' },
    requestedExecutionDate: today(),
    method: 'TRANSFER',
    purpose: 'SUPPLIERS',
    transfers: [
      sampleTransfer({
        endToEndId: `${messageId}-1`.slice(0, 35),
        route: 'INTRABANK',
        amount: '100.00',
        currency,
        creditorAccountType: 'CHECKING',
        references: ['INV-0001'],
      }),
      sampleTransfer({
        endToEndId: `${messageId}-2`.slice(0, 35),
        route: 'DOMESTIC_CLEARING',
        creditorBankCode: '001',
        amount: '50.25',
        currency,
        creditor: { name: 'Local Vendor' },
      }),
      sampleTransfer({
        endToEndId: `${messageId}-3`.slice(0, 35),
        route: 'CROSS_BORDER',
        creditorBankBic: 'SIMBUS33XXX',
        amount: '200.00',
        currency: 'USD',
        creditor: { name: 'Overseas Supplier', address: { town: 'Miami', country: 'US', line: '1 Example Way' } },
        creditorAccount: { number: '555000111' },
      }),
    ],
    ...overrides,
  };
}

/** Engine whose local currencies come from the connectors' country profiles. */
export function simulationFor(connectors: readonly BankConnector[], options: Omit<SimulationOptions, 'currencyByCountry'> = {}) {
  const currencyByCountry: Record<string, string> = {};
  for (const c of connectors) for (const p of c.countries) currencyByCountry[p.code] ??= p.localCurrency;
  return createSimulationEngine({ ...options, currencyByCountry });
}
