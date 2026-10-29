import {
  BalanceTypeCodes,
  buildAccountReportDocument,
  buildAccountReportingRequest,
  buildCustomerCreditTransferInitiation,
  buildMessageRejectDocument,
  buildPaymentStatusReportDocument,
  buildStatementDocument,
  buildStatusReportRequest,
  buildSystemEventDocument,
  Camt060Document,
  CURRENCIES,
  deriveState,
  detectMessage,
  errorCategory,
  ibanFromBban,
  isIso4217,
  isoDateTime,
  isValidAmount,
  isValidBic,
  isValidIban,
  isWellFormedIban,
  jsonSchemaFor,
  MESSAGE_SCHEMAS,
  normalizeCurrency,
  Pain001Document,
  type PaymentBatch,
  PaymentStatusCodes,
  parseAccountReport,
  parseCustomerCreditTransferInitiation,
  parseMessageReject,
  parsePaymentStatusReport,
  parseStatement,
  parseSystemEvent,
  paymentState,
  sumAmounts,
  Tsmt038Document,
  transactionType,
} from '@iso20022-bank-kit/iso20022';
import { describe, expect, it } from 'vitest';

const parties = { clientBic: 'CLIENTXX', ownerBic: 'OWNERXXX', bankBic: 'SIMBUS33' };

const batch: PaymentBatch = {
  messageId: 'MSG-1',
  country: 'US',
  debtorName: 'Example Corp',
  debtorAccount: { number: '999888666' },
  requestedExecutionDate: '2026-01-02',
  transfers: [
    {
      endToEndId: 'E1',
      route: 'INTRABANK',
      amount: '0.10',
      currency: 'USD',
      creditor: { name: 'A' },
      creditorAccount: { number: '1' },
      creditorAccountType: 'SAVINGS',
      references: ['INV-1'],
    },
    {
      endToEndId: 'E2',
      route: 'DOMESTIC_CLEARING',
      creditorBankCode: '021',
      amount: '0.20',
      currency: 'USD',
      creditor: { name: 'B', id: 'TAX1' },
      creditorAccount: { number: '2' },
    },
    {
      endToEndId: 'E3',
      route: 'CROSS_BORDER',
      creditorBankBic: 'SIMBGB2LXXX',
      amount: '1250.5',
      currency: 'GBP',
      creditor: { name: 'C', address: { town: 'London', country: 'GB', line: '1 High St' } },
      creditorAccount: { iban: 'GB52SIMB00000012345678' },
      purposeCode: '26.3',
    },
  ],
};

describe('validators', () => {
  it('IBAN: mod-97 and format (ISO 13616)', () => {
    expect(isValidIban('GB52SIMB00000012345678')).toBe(true);
    expect(isValidIban('GB53SIMB00000012345678')).toBe(false);
    expect(isWellFormedIban('GB53SIMB00000012345678')).toBe(true);
    expect(isValidIban('gb52 simb 0000 0012 3456 78')).toBe(true);
    expect(isValidIban(ibanFromBban('CR', '0102000099988866600'))).toBe(true);
  });
  it('BIC (ISO 9362)', () => {
    expect(isValidBic('BMILHNTE')).toBe(true);
    expect(isValidBic('BMILHNTEXXX')).toBe(true);
    expect(isValidBic('BMIL1NTE')).toBe(false);
    expect(isValidBic('BMILHNTEXX')).toBe(false);
  });
  it('amounts are positive decimals with bounded fraction digits', () => {
    expect(isValidAmount('10')).toBe(true);
    expect(isValidAmount('10.25')).toBe(true);
    expect(isValidAmount('0')).toBe(false);
    expect(isValidAmount('0.00')).toBe(false);
    expect(isValidAmount('1.234')).toBe(false);
    expect(isValidAmount('-1')).toBe(false);
  });
  it('IBK-PAY-004: sums are exact decimal arithmetic', () => {
    expect(sumAmounts(['0.1', '0.2'])).toBe('0.30');
    expect(sumAmounts(['999999999999999.99', '0.01'])).toBe('1000000000000000.00');
    expect(sumAmounts([])).toBe('0.00');
  });
});

describe('codes', () => {
  it('IBK-MOD-002: unmapped codes become UNKNOWN and never throw', () => {
    expect(BalanceTypeCodes.toDomain('ZZZZ')).toBe('UNKNOWN');
    expect(PaymentStatusCodes.toDomain(undefined)).toBe('UNKNOWN');
    expect(transactionType('NTRF')).toBe('TRANSFER');
    expect(transactionType('TRF')).toBe('TRANSFER');
    expect(transactionType('XYZ')).toBe('UNKNOWN');
  });
  it('IBK-STS-001: coarse payment state', () => {
    expect(paymentState('ACCEPTED_SETTLEMENT_COMPLETED')).toBe('COMPLETED');
    expect(paymentState('ACCEPTED_CREDITOR_SETTLEMENT_COMPLETED')).toBe('COMPLETED');
    expect(paymentState('REJECTED')).toBe('FAILED');
    expect(paymentState('CANCELLED')).toBe('FAILED');
    expect(paymentState('PARTIALLY_ACCEPTED')).toBe('PARTIAL');
    expect(paymentState('RECEIVED')).toBe('IN_PROGRESS');
    expect(paymentState('ACCEPTED_TECHNICAL_VALIDATION')).toBe('IN_PROGRESS');
    expect(paymentState('UNKNOWN')).toBe('UNKNOWN');
  });
  it('IBK-MOD-003: currency normalisation and the ISO 4217 list', () => {
    expect(normalizeCurrency('lps', { LPS: 'HNL' })).toBe('HNL');
    expect(normalizeCurrency('usd')).toBe('USD');
    expect(normalizeCurrency(null)).toBeNull();
    expect(CURRENCIES.length).toBeGreaterThan(150);
    expect(isIso4217('HNL')).toBe(true);
    expect(isIso4217('LPS')).toBe(false);
  });
  it('HTTP status categories', () => {
    expect(errorCategory(422)).toBe('VALIDATION_FAILED');
    expect(errorCategory(502)).toBe('INTERNAL_ERROR');
    expect(errorCategory(418)).toBe('BAD_REQUEST');
  });
  it('isoDateTime keeps the requested offset', () => {
    expect(isoDateTime(new Date('2026-01-02T14:00:00Z'), -360)).toBe('2026-01-02T08:00:00-06:00');
    expect(isoDateTime(new Date('2026-01-02T14:00:00Z'), 90)).toBe('2026-01-02T15:30:00+01:30');
  });
});

describe('request builders', () => {
  it('IBK-PAY-004: pain.001 derives NbOfTxs and CtrlSum', () => {
    const m = buildCustomerCreditTransferInitiation({
      parties,
      batch,
      createdAt: '2026-01-02T08:00:00Z',
      resolver: { intrabankClearingCode: () => '999' },
    });
    const doc = Pain001Document.parse(m.Document);
    expect(doc.CstmrCdtTrfInitn.GrpHdr.NbOfTxs).toBe('3');
    expect(doc.CstmrCdtTrfInitn.GrpHdr.CtrlSum).toBe('1250.8');
    const txs = doc.CstmrCdtTrfInitn.PmtInf[0]?.CdtTrfTxInf ?? [];
    expect(txs[0]?.CdtrAgt?.FinInstnId.ClrSysMmbId?.MmbId).toBe('999');
    expect(txs[1]?.CdtrAgt?.FinInstnId.ClrSysMmbId?.MmbId).toBe('021');
    expect(txs[2]?.CdtrAgt?.FinInstnId.BIC).toBe('SIMBGB2LXXX');
    expect(m.AppHdr).toMatchObject({ MsgDefIdr: 'pain.001.001.03', BizMsgIdr: 'MSG-1' });
  });
  it('profiles change conventions without forking builders (IBK-PLG-003)', () => {
    const m = buildCustomerCreditTransferInitiation({
      parties,
      batch,
      createdAt: '2026-01-02T08:00:00Z',
      profile: {
        bizSvc: 'x',
        msgDefIdr: { camt060: 'a', tsmt038: 'b', pain001: 'PaymentInitiationServiceV03' },
        reqdMsgNmId: { balance: 'B', CAMT053: 'C', MT940: 'M', MT942: 'N' },
        currencyKey: '-Ccy',
        includeXmlns: false,
        omitAccountTypeIn: ['US'],
      },
    });
    const tx = (m.Document as { CstmrCdtTrfInitn: { PmtInf: { CdtTrfTxInf: Record<string, Record<string, unknown>>[] }[] } })
      .CstmrCdtTrfInitn.PmtInf[0]?.CdtTrfTxInf[0];
    expect(tx?.Amt?.InstdAmt).toEqual({ '-Ccy': 'USD', InstdAmt: '0.10' });
    expect(tx?.CdtrAcct?.Tp).toBeUndefined();
    expect(m.AppHdr.MsgDefIdr).toBe('PaymentInitiationServiceV03');
  });
  it('camt.060 for balance and for each statement format', () => {
    const balance = buildAccountReportingRequest({
      parties,
      account: { iban: 'GB52SIMB00000012345678' },
      requestId: 'R1',
      createdAt: '2026-01-02T08:00:00Z',
    });
    expect(Camt060Document.parse(balance.Document).AcctRptgReq.RptgReq).toMatchObject({
      ReqdMsgNmId: 'camt.052.001.08',
      Acct: { Id: { IBAN: 'GB52SIMB00000012345678' } },
    });
    const mt942 = buildAccountReportingRequest({
      parties,
      account: { number: '1' },
      format: 'MT942',
      period: { fromDate: '2026-01-01' },
      requestId: 'R2',
      createdAt: '2026-01-02T08:00:00Z',
    });
    expect(Camt060Document.parse(mt942.Document).AcctRptgReq.RptgReq.RptgPrd).toEqual({
      FrToDt: { FrDt: '2026-01-01', ToDt: '2026-01-01' },
      FrToTm: { FrTm: '00:00:00.000', ToTm: '23:59:59.000' },
      Tp: 'ALLL',
    });
    expect(() =>
      buildAccountReportingRequest({ parties, account: { number: '1' }, format: 'CAMT053', requestId: 'x', createdAt: 'x' }),
    ).toThrow(/period/);
  });
  it('tsmt.038 status request', () => {
    const m = buildStatusReportRequest({ parties, messageId: 'MSG-1', requestId: 'R', createdAt: '2026-01-02T08:00:00Z' });
    expect(Tsmt038Document.parse(m.Document).StsRptReq).toEqual({
      ReqId: { Id: 'MSG-1', CreDtTm: '2026-01-02T08:00:00Z' },
      NttiesToBeRptd: { BIC: 'OWNERXXX' },
    });
  });
});

describe('parsers round-trip bank-side documents', () => {
  it('camt.052', () => {
    const doc = buildAccountReportDocument({
      messageId: 'M',
      createdAt: '2026-01-02T08:00:00Z',
      reportId: 'R',
      account: { number: '1' },
      currency: 'LPS',
      balances: [{ type: 'INTERIM_AVAILABLE', creditDebit: 'CREDIT', amount: '10.50', dateTime: '2026-01-02T08:00:00Z' }],
    });
    const r = parseAccountReport(doc, {}, { currencyAliases: { LPS: 'HNL' } });
    expect(r.balances[0]).toMatchObject({
      type: 'INTERIM_AVAILABLE',
      typeCode: 'ITAV',
      amount: '10.50',
      currency: 'HNL',
      date: '2026-01-02',
    });
    expect(r.account.currency).toBe('HNL');
  });
  it('camt.053 keeps raw codes and endToEndId', () => {
    const doc = buildStatementDocument({
      messageId: 'M',
      createdAt: '2026-01-02T08:00:00Z',
      statementId: 'S',
      sequenceNumber: 1,
      account: { number: '1' },
      currency: 'USD',
      fromDateTime: '2026-01-01T00:00:00Z',
      toDateTime: '2026-01-01T23:59:59Z',
      balances: [{ type: 'OPENING_BOOKED', creditDebit: 'CREDIT', amount: '100.00', date: '2026-01-01' }],
      entries: [
        {
          reference: 'R1',
          amount: '1.00',
          creditDebit: 'DEBIT',
          bookingDate: '2026-01-01',
          valueDate: '2026-01-01',
          transactionType: 'TRF',
          endToEndId: 'E1',
          description: 'x',
        },
      ],
    });
    const s = parseStatement(doc);
    expect(s.entries[0]).toMatchObject({
      reference: 'R1',
      endToEndId: 'E1',
      transactionType: 'TRANSFER',
      transactionTypeCode: 'NTRF',
      status: 'BOOKED',
      creditDebit: 'DEBIT',
      amount: '1.00',
    });
  });
  it('IBK-STS-002: pain.002 with mixed outcomes is PARTIAL even when the group says RJCT', () => {
    const t = (endToEndId: string, status: 'REJECTED' | 'ACCEPTED_SETTLEMENT_COMPLETED') => ({
      endToEndId,
      status,
      reasonCode: '0',
      info: '',
      amount: '1.00',
      currency: 'USD',
      requestedExecutionDate: '2026-01-01',
      creditorName: 'A',
      creditorAccount: { number: '1' },
    });
    const doc = buildPaymentStatusReportDocument({
      reportId: 'L2',
      createdAt: 'x',
      originalMessageId: 'M',
      originalCreatedAt: 'x',
      paymentInfoId: 'P',
      groupStatus: 'REJECTED',
      groupInfo: 'partial or total',
      transfers: [t('A', 'REJECTED'), t('B', 'ACCEPTED_SETTLEMENT_COMPLETED')],
    });
    const r = parsePaymentStatusReport(doc);
    expect(r.statusCode).toBe('RJCT');
    expect(r.state).toBe('PARTIAL');
    expect(r.paymentInfos[0]?.state).toBe('PARTIAL');
    expect(r.paymentInfos[0]?.transactions.map((x) => x.state)).toEqual(['FAILED', 'COMPLETED']);
    expect(
      deriveState({ status: 'REJECTED', statusCode: 'RJCT', state: 'FAILED' }, [
        { status: 'REJECTED', statusCode: 'RJCT', state: 'FAILED', count: 1, controlSum: '1' },
      ]).state,
    ).toBe('FAILED');
  });
  it('admi.004 and admi.002', () => {
    expect(parseSystemEvent(buildSystemEventDocument({ eventCode: 'RCVD', description: 'ok', eventTime: 't' })).eventCode).toBe('RCVD');
    expect(parseMessageReject(buildMessageRejectDocument({ reasonCode: '1010', description: 'dup' }))).toEqual({
      code: 'DUPLICATE_MESSAGE_ID',
      bankCode: '1010',
      description: 'dup',
    });
    expect(parseMessageReject({ something: 'else' })).toBeNull();
  });
  it('pain.001 -> PaymentBatch inverts the builder', () => {
    const m = buildCustomerCreditTransferInitiation({
      parties,
      batch,
      createdAt: '2026-01-02T08:00:00Z',
      resolver: { intrabankClearingCode: () => '999' },
    });
    const back = parseCustomerCreditTransferInitiation(m.Document, { intrabankCodes: ['999'] });
    expect(back.transfers.map((t) => t.route)).toEqual(['INTRABANK', 'DOMESTIC_CLEARING', 'CROSS_BORDER']);
    expect(back.transfers[2]?.creditor.address).toEqual({ town: 'London', country: 'GB', line: '1 High St' });
    expect(back.transfers[0]?.creditorAccountType).toBe('SAVINGS');
    expect(back.messageId).toBe('MSG-1');
  });
});

describe('schemas', () => {
  it('detects every message by its root element', () => {
    expect(detectMessage({ CstmrCdtTrfInitn: {} })).toBe('pain.001.001.03');
    expect(detectMessage({ BkToCstmrStmt: {} })).toBe('camt.053.001.08');
    expect(detectMessage({ nope: 1 })).toBeNull();
  });
  it('exports a JSON Schema for every message', () => {
    for (const id of Object.keys(MESSAGE_SCHEMAS) as (keyof typeof MESSAGE_SCHEMAS)[]) {
      const s = jsonSchemaFor(id);
      expect(s.$schema ?? s.type, id).toBeTruthy();
    }
  });
});
