// Generic payment rules every connector gets for free (SPEC IBK-PAY-005). All problems are
// collected so callers can fix them in one pass.

import type { AccountRef, PaymentBatch } from '@iso20022-bank-kit/iso20022';
import { isIso4217, isIsoDate, isValidAmount, isValidBic, isValidIban, isWellFormedIban, MAX35, MAX140 } from '@iso20022-bank-kit/iso20022';
import type { BankConnector } from './connector.js';

export function validateAccountRef(
  account: AccountRef,
  path: string,
  problems: string[],
  ibanCheckDigits: 'enforce' | 'format-only' = 'enforce',
): void {
  if (Boolean(account.number) === Boolean(account.iban)) problems.push(`${path}: give exactly one of number or iban`);
  if (account.iban && !(ibanCheckDigits === 'enforce' ? isValidIban(account.iban) : isWellFormedIban(account.iban))) {
    problems.push(`${path}.iban is not a valid IBAN (${ibanCheckDigits === 'enforce' ? 'format or check digits' : 'format'})`);
  }
  if (account.number && account.number.length > 34) problems.push(`${path}.number must be at most 34 characters`);
}

export function validatePaymentBatch(batch: PaymentBatch, connector?: BankConnector): string[] {
  const p: string[] = [];
  const len = (v: string | undefined, max: number, path: string) => {
    if (v && v.length > max) p.push(`${path} must be at most ${max} characters`);
  };
  if (!batch.messageId) p.push('messageId is required');
  len(batch.messageId, MAX35, 'messageId');
  len(batch.paymentInfoId, MAX35, 'paymentInfoId');
  len(batch.debtorName, MAX140, 'debtorName');
  if (!isIsoDate(batch.requestedExecutionDate)) p.push('requestedExecutionDate must be a valid YYYY-MM-DD date');
  const ibanMode = connector?.capabilities.ibanCheckDigits ?? 'enforce';
  validateAccountRef(batch.debtorAccount, 'debtorAccount', p, ibanMode);
  if (!batch.transfers.length) p.push('transfers must contain at least one transfer');

  const profile = connector?.countries.find((c) => c.code === batch.country);
  if (connector && !profile) p.push(`country ${batch.country} is not supported by ${connector.name}`);
  if (profile?.requiresIban && !batch.debtorAccount.iban) p.push(`debtorAccount: ${batch.country} accounts must use iban`);

  const seen = new Set<string>();
  batch.transfers.forEach((t, i) => {
    const at = `transfers[${i}]`;
    len(t.endToEndId, MAX35, `${at}.endToEndId`);
    if (seen.has(t.endToEndId)) p.push(`${at}.endToEndId "${t.endToEndId}" is repeated in this batch`);
    seen.add(t.endToEndId);
    if (!isValidAmount(t.amount)) p.push(`${at}.amount must be a positive decimal with at most 2 decimals`);
    if (!isIso4217(t.currency)) p.push(`${at}.currency "${t.currency}" is not an ISO 4217 code`);
    len(t.creditor.name, MAX140, `${at}.creditor.name`);
    validateAccountRef(t.creditorAccount, `${at}.creditorAccount`, p, ibanMode);
    if (connector && !connector.capabilities.routes.includes(t.route))
      p.push(`${at}.route ${t.route} is not supported by ${connector.name}`);

    switch (t.route) {
      case 'DOMESTIC_CLEARING':
        if (!t.creditorBankCode) p.push(`${at}.creditorBankCode is required for DOMESTIC_CLEARING`);
        break;
      case 'CROSS_BORDER':
        if (!t.creditorBankBic) p.push(`${at}.creditorBankBic is required for CROSS_BORDER`);
        else if (!isValidBic(t.creditorBankBic)) p.push(`${at}.creditorBankBic is not a valid BIC`);
        if (!t.creditor.address) p.push(`${at}.creditor.address is required for CROSS_BORDER`);
        else if (!/^[A-Z]{2}$/.test(t.creditor.address.country)) p.push(`${at}.creditor.address.country must be an ISO 3166 alpha-2 code`);
        break;
      case 'INTRABANK':
        break;
    }
    if (t.route !== 'CROSS_BORDER' && t.creditorBankBic) p.push(`${at}.creditorBankBic is only used for CROSS_BORDER`);
    if (t.route !== 'CROSS_BORDER' && profile?.requiresIban && !t.creditorAccount.iban)
      p.push(`${at}.creditorAccount: ${batch.country} accounts must use iban`);
    (t.references ?? []).forEach((r, j) => {
      len(r, MAX35, `${at}.references[${j}]`);
    });
  });
  if (connector?.validatePayment) p.push(...connector.validatePayment(batch));
  return [...new Set(p)];
}
