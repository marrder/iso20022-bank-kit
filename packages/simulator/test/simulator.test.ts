import { isSimFailure } from '@iso20022-bank-kit/core';
import {
  createSimulationEngine,
  DUPLICATE_REASON_CODE,
  SCENARIOS,
  SEED_ENTRIES,
  sampleBatch,
  uniqueMessageId,
} from '@iso20022-bank-kit/simulator';
import { describe, expect, it } from 'vitest';

const now = () => new Date('2026-03-10T12:00:00Z');
const engine = () => createSimulationEngine({ now, currencyByCountry: { US: 'USD' } });
const acct = { number: '999888666' };

describe('simulation engine (SPEC clause 11)', () => {
  it('IBK-SIM-001: deterministic opening balance and five seed entries yesterday', () => {
    const a = engine().statement('US', acct, '2026-03-09', '2026-03-09');
    const b = engine().statement('US', acct, '2026-03-09', '2026-03-09');
    expect(a).toEqual(b);
    if (isSimFailure(a)) throw new Error('unexpected');
    expect(a.entries).toHaveLength(SEED_ENTRIES.length);
    expect(a.entries.every((e) => e.bookingDate === '2026-03-09')).toBe(true);
    expect(a.currency).toBe('USD');
  });
  it('payments debit the ledger and appear in today’s statement', () => {
    const e = engine();
    const before = e.balance('US', acct);
    e.submitPayment(sampleBatch('US', 'USD', { messageId: 'P1' }));
    const after = e.balance('US', acct);
    if (isSimFailure(before) || isSimFailure(after)) throw new Error('unexpected');
    expect(Number(before.available.amount) - Number(after.available.amount)).toBeCloseTo(350.25, 2);
    const today = e.statement('US', acct, '2026-03-10', '2026-03-10');
    if (isSimFailure(today)) throw new Error('unexpected');
    expect(today.entries.map((x) => x.endToEndId)).toEqual(['P1-1', 'P1-2', 'P1-3']);
  });
  it('IBK-SIM-002: MOCK-500 books and fails with 500', () => {
    const e = engine();
    const id = uniqueMessageId(SCENARIOS.serverErrorAfterBooking);
    expect(e.submitPayment(sampleBatch('US', 'USD', { messageId: id }))).toEqual({ kind: 'server_error', httpStatus: 500, booked: true });
    expect(isSimFailure(e.paymentStatus(id))).toBe(false);
  });
  it('IBK-SIM-003: MOCK-503 does not book', () => {
    const e = engine();
    const id = uniqueMessageId(SCENARIOS.unavailable);
    expect(e.submitPayment(sampleBatch('US', 'USD', { messageId: id })).kind).toBe('unavailable');
    expect(isSimFailure(e.paymentStatus(id))).toBe(true);
  });
  it('IBK-SIM-004: status progresses from technical acceptance to final', () => {
    const e = engine();
    e.submitPayment(sampleBatch('US', 'USD', { messageId: 'P2' }));
    const first = e.paymentStatus('P2');
    const second = e.paymentStatus('P2');
    if (isSimFailure(first) || isSimFailure(second)) throw new Error('unexpected');
    expect(first.groupStatus).toBe('RECEIVED');
    expect(first.transfers.every((t) => t.status === 'ACCEPTED_TECHNICAL_VALIDATION')).toBe(true);
    expect(second.groupStatus).toBe('ACCEPTED_SETTLEMENT_COMPLETED');
  });
  it('IBK-SIM-005: REJECT creditors fail alone, and are not debited', () => {
    const e = engine();
    const b = sampleBatch('US', 'USD', { messageId: 'P3' });
    b.transfers[0] = { ...b.transfers[0]!, creditor: { name: 'please reject' } };
    e.submitPayment(b);
    e.paymentStatus('P3');
    const s = e.paymentStatus('P3');
    if (isSimFailure(s)) throw new Error('unexpected');
    expect(s.transfers.map((t) => t.status)).toEqual(['REJECTED', 'ACCEPTED_SETTLEMENT_COMPLETED', 'ACCEPTED_SETTLEMENT_COMPLETED']);
    expect(s.groupStatus).toBe('REJECTED');
    const st = e.statement('US', acct, '2026-03-10', '2026-03-10');
    if (isSimFailure(st)) throw new Error('unexpected');
    expect(st.entries).toHaveLength(2);
  });
  it('IBK-SIM-006: account 000000000 is rejected with 422', () => {
    const r = engine().balance('US', { number: SCENARIOS.rejectedAccount });
    expect(r).toMatchObject({ kind: 'rejected', httpStatus: 422 });
    expect(engine().submitPayment(sampleBatch('US', 'USD', { debtorAccount: { number: SCENARIOS.rejectedAccount } }))).toMatchObject({
      httpStatus: 422,
    });
  });
  it('IBK-SIM-007: MOCK-TIMEOUT books then times out', () => {
    const e = engine();
    const id = uniqueMessageId(SCENARIOS.timeoutAfterBooking);
    expect(e.submitPayment(sampleBatch('US', 'USD', { messageId: id }))).toEqual({ kind: 'timeout', booked: true });
    expect(isSimFailure(e.paymentStatus(id))).toBe(false);
  });
  it('IBK-SIM-008: duplicate messageId is rejected with 1010', () => {
    const e = engine();
    const b = sampleBatch('US', 'USD', { messageId: 'P4' });
    e.submitPayment(b);
    expect(e.submitPayment(b)).toMatchObject({ kind: 'duplicate', reasonCode: DUPLICATE_REASON_CODE });
  });
  it('unknown messageId status is a 404', () => {
    expect(engine().paymentStatus('nope')).toMatchObject({ httpStatus: 404 });
  });
});
