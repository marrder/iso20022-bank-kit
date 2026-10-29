import { mtToStatement, parseMt, writeMt } from '@iso20022-bank-kit/swift-mt';
import { describe, expect, it } from 'vitest';

// Synthetic messages (fictional bank, accounts and amounts).
const MT940 = [
  '{1:F01SIMBUS33AXXX0000000000}{2:O9401200260102SIMCLIENTXXX0000000000000000000000N}{4:',
  ':20:STMT0001',
  ':25:US00SIMB1234567890',
  ':28C:0102/1',
  ':60F:C260101USD1000,00',
  ':61:2601020102D125,50NTRFPAY-001//BANKREF1',
  ':86:/Supplier payment',
  ':61:2601020102C40,NMSCREC-002',
  ':86:/Customer receipt',
  ':61:2601020102RD5,00NCHGFEE-003',
  ':62F:C260102USD909,50',
  ':64:C260102USD909,50',
  ':65:C260103USD909,50',
  ':86:END OF STATEMENT',
  '-}',
].join('\r\n');

const MT942 = [
  '{1:F01SIMBUS33AXXX0000000000}{2:O9421200260102SIMCLIENTXXX0000000000000000000000N}{4:',
  ':20:INTR0001',
  ':25:123456789',
  ':28C:0102/1',
  ':34F:USDD0,00',
  ':13D:2601021430-0500',
  ':61:2601020102D10,00NTRFE2E-1',
  ':86:/Payroll',
  ':90D:1USD10,00',
  ':90C:0USD0,00}',
].join('\r\n');

describe('MT940', () => {
  it('parses balances, entries, reversal marks and :86: placement', () => {
    const m = parseMt(MT940);
    expect(m.messageType).toBe('MT940');
    expect(m.senderBic).toBe('SIMBUS33');
    expect(m.balances.map((b) => [b.type, b.creditDebit, b.amount])).toEqual([
      ['OPBD', 'CRDT', '1000.00'],
      ['CLBD', 'CRDT', '909.50'],
      ['CLAV', 'CRDT', '909.50'],
      ['FWAV', 'CRDT', '909.50'],
    ]);
    expect(m.entries).toHaveLength(3);
    expect(m.entries[0]).toMatchObject({
      amount: '125.50',
      creditDebit: 'DBIT',
      reference: 'PAY-001',
      bankReference: 'BANKREF1',
      description: 'Supplier payment',
      transactionType: 'TRF',
    });
    expect(m.entries[1]?.amount).toBe('40.00');
    expect(m.entries[2]).toMatchObject({ reversal: true, creditDebit: 'DBIT', transactionType: 'CHG', description: null });
    expect(m.information).toBe('END OF STATEMENT');
  });
  it('IBK-STM-001: normalises to the ISO Statement model', () => {
    const s = mtToStatement(MT940);
    expect(s.format).toBe('MT940');
    expect(s.account).toEqual({ number: null, iban: 'US00SIMB1234567890', currency: 'USD' });
    expect(s.balances[0]).toMatchObject({ type: 'OPENING_BOOKED', typeCode: 'OPBD', creditDebit: 'CREDIT' });
    expect(s.entries[0]).toMatchObject({ transactionType: 'TRANSFER', transactionTypeCode: 'TRF', status: 'BOOKED', currency: 'USD' });
    expect(s.raw).toBe(MT940);
  });
});

describe('MT942', () => {
  it('parses floor limit, report time and summaries', () => {
    const s = mtToStatement(MT942);
    expect(s.format).toBe('MT942');
    expect(s.createdAt).toBe('2026-01-02T14:30:00-05:00');
    expect(s.interim).toEqual({
      floorLimit: { amount: '0.00', currency: 'USD' },
      debits: { count: 1, amount: '10.00', currency: 'USD' },
      credits: { count: 0, amount: '0.00', currency: 'USD' },
    });
    expect(s.account.number).toBe('123456789');
  });
});

describe('writer', () => {
  it('round-trips through the parser', () => {
    for (const messageType of ['MT940', 'MT942'] as const) {
      const text = writeMt({
        messageType,
        senderBic: 'SIMBUS33',
        receiverBic: 'CLIENTXX',
        transactionReference: 'R1',
        account: '42',
        sequence: '0101/1',
        currency: 'EUR',
        opening: { creditDebit: 'CRDT', date: '2026-01-01', amount: '10.00' },
        closing: { creditDebit: 'DBIT', date: '2026-01-01', amount: '2.50' },
        entries: [
          {
            valueDate: '2026-01-01',
            bookingDate: '2026-01-01',
            creditDebit: 'DBIT',
            amount: '12.50',
            transactionType: 'TRF',
            reference: 'E2E',
            description: 'x',
          },
        ],
        reportDateTime: '2026-01-01T10:15:00Z',
      });
      const m = parseMt(text);
      expect(m.messageType).toBe(messageType);
      expect(m.entries[0]).toMatchObject({ amount: '12.50', reference: 'E2E', description: 'x' });
      if (messageType === 'MT940') expect(m.balances.map((b) => b.amount)).toEqual(['10.00', '2.50']);
      else expect(m.debitSummary).toEqual({ count: 1, currency: 'EUR', amount: '12.50' });
    }
  });
});
