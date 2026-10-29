// Markdown renderers for tool results.
import type { BalanceReport, PaymentOutcome, PaymentStatusReport, Statement } from '@iso20022-bank-kit/iso20022';

const money = (amount: string | null, currency: string | null) => (amount == null ? '—' : `${amount} ${currency ?? ''}`.trim());
const acct = (a: { iban: string | null; number: string | null }) => a.iban ?? a.number ?? '—';
const cell = (s: unknown) =>
  String(s ?? '')
    .replaceAll('|', '\\|')
    .replace(/\s+/g, ' ');

export function balance(b: BalanceReport): string {
  const lines = [`# Balance of ${acct(b.account)} (${b.country ?? '?'})`];
  for (const x of b.balances)
    lines.push(
      `- **${x.type}**: ${x.creditDebit === 'DEBIT' ? '−' : ''}${money(x.amount, x.currency)} (as of ${x.dateTime ?? x.date ?? 'n/a'})`,
    );
  if (!b.balances.length) lines.push('No balance returned.');
  return lines.join('\n');
}

export function statement(
  s: Statement & { total_entries: number; offset: number; count: number; has_more: boolean; next_offset?: number },
): string {
  const lines = [`# ${s.format} statement for ${acct(s.account)} (${s.country ?? '?'})`];
  for (const b of s.balances)
    lines.push(`- ${b.type}: ${b.creditDebit === 'DEBIT' ? '−' : ''}${money(b.amount, b.currency)} (${b.date ?? ''})`);
  if (s.interim?.debits)
    lines.push(`- Debits: ${s.interim.debits.count} totalling ${money(s.interim.debits.amount, s.interim.debits.currency)}`);
  if (s.interim?.credits)
    lines.push(`- Credits: ${s.interim.credits.count} totalling ${money(s.interim.credits.amount, s.interim.credits.currency)}`);
  lines.push('', `Showing entries ${s.count ? s.offset + 1 : 0}–${s.offset + s.count} of ${s.total_entries}.`, '');
  if (s.count) {
    lines.push('| Booked | Amount | Type | Reference | End-to-end id | Description |', '|---|---|---|---|---|---|');
    for (const e of s.entries) {
      lines.push(
        `| ${e.bookingDate ?? ''} | ${e.creditDebit === 'DEBIT' ? '−' : '+'}${money(e.amount, e.currency)} | ${e.transactionType} | ${cell(e.reference)} | ${cell(e.endToEndId)} | ${cell(e.description)} |`,
      );
    }
  }
  if (s.has_more) lines.push('', `More entries: call again with offset=${s.next_offset}.`);
  return lines.join('\n');
}

export function paymentStatus(p: PaymentStatusReport): string {
  const lines = [
    `# Payment ${p.messageId}: ${p.state}`,
    `Bank status ${p.status} (${p.statusCode ?? '—'})${p.statusInfo ? ` — ${p.statusInfo}` : ''}`,
    `${p.numberOfTransactions} transfer(s), control sum ${p.controlSum ?? '—'}`,
  ];
  for (const info of p.paymentInfos) {
    lines.push('', '| End-to-end id | State | Status | Amount | Creditor | Info |', '|---|---|---|---|---|---|');
    for (const t of info.transactions) {
      lines.push(
        `| ${cell(t.endToEndId)} | ${t.state} | ${t.status} | ${money(t.amount, t.currency)} | ${cell(t.creditorName)} | ${cell(t.statusInfo)}${t.reasonCode && t.reasonCode !== '0' ? ` (code ${t.reasonCode})` : ''} |`,
      );
    }
  }
  if (p.state === 'IN_PROGRESS') lines.push('', 'Still processing: check again later.');
  return lines.join('\n');
}

export function paymentOutcome(r: PaymentOutcome): string {
  switch (r.result) {
    case 'SUBMITTED':
      return `SUBMITTED: batch ${r.messageId} was received by the bank (${r.eventCode ?? '—'}). Follow it with bank_get_payment_status.`;
    case 'REJECTED':
      return r.duplicate
        ? `REJECTED (duplicate): batch ${r.messageId} already exists at the bank, so nothing new was sent. Check it with bank_get_payment_status.`
        : `REJECTED: batch ${r.messageId} was not processed (${r.category}${r.bankCode ? `, bank code ${r.bankCode}` : ''}): ${r.description ?? 'no description'}. Fix the problem and resubmit.`;
    case 'OUTCOME_UNKNOWN':
      return `OUTCOME UNKNOWN: the bank did not confirm batch ${r.messageId} (${r.category}${r.httpStatus ? ` HTTP ${r.httpStatus}` : ''}). The debit MAY have happened. Do NOT resend. Call bank_get_payment_status with message_id "${r.messageId}" and tell the user.`;
  }
}
