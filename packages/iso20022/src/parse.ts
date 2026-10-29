// Parses ISO 20022 JSON documents into the domain model. Every enum keeps its raw code
// (SPEC IBK-MOD-002) and currencies are normalised to ISO 4217 (SPEC IBK-MOD-003).
import type * as z from 'zod';
import {
  AccountTypeCodes,
  BalanceTypeCodes,
  CreditDebitCodes,
  EntryStatusCodes,
  normalizeCurrency,
  PaymentStatusCodes,
  paymentState,
  transactionType,
} from './codes.js';
import type {
  Account,
  Balance,
  BalanceReport,
  BankErrorCode,
  Entry,
  PaymentStatusCode,
  PaymentStatusReport,
  Statement,
  StatusCount,
  StatusFields,
} from './model.js';
import { Admi002Document, Admi004Document, Camt052Document, Camt053Document, Pain001Document, Pain002Document } from './schemas.js';

export interface ParseOptions {
  /** Bank-specific non-ISO currency codes, e.g. { LPS: 'HNL' }. */
  currencyAliases?: Readonly<Record<string, string>>;
  /** Country of the servicing bank, resolved from AppHdr.Fr by the connector. */
  country?: string | null;
}

export class MessageParseError extends Error {
  constructor(
    readonly messageType: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(`Not a valid ${messageType}: ${issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  }
}

function parseWith<T extends z.ZodType>(schema: T, name: string, document: unknown): z.output<T> {
  const r = schema.safeParse(document);
  if (!r.success) throw new MessageParseError(name, r.error.issues);
  return r.data;
}

const arr = <T>(x: T | T[] | undefined | null): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const str = (x: unknown): string | null => (x == null ? null : String(x));

function creditDebit(code: string | undefined): Entry['creditDebit'] {
  return CreditDebitCodes.toDomain(code);
}

function account(acct: { Id: Record<string, unknown>; Ccy?: string | undefined }, o: ParseOptions): Account {
  const id = acct.Id as { IBAN?: string; Othr?: { Id?: string } };
  return { number: id.Othr?.Id ?? null, iban: id.IBAN ?? null, currency: normalizeCurrency(acct.Ccy, o.currencyAliases) };
}

type RawBalance = z.output<typeof Camt053Document>['BkToCstmrStmt']['Stmt']['Bal'];
function balance(b: Exclude<RawBalance, unknown[] | undefined>, o: ParseOptions): Balance {
  const code = b.Tp?.CdOrPrtry.Cd ?? b.Tp?.CdOrPrtry.Prtry ?? null;
  return {
    type: BalanceTypeCodes.toDomain(code),
    typeCode: code,
    creditDebit: creditDebit(b.CdtDbtInd),
    amount: str(b.Amt?.Amt),
    currency: normalizeCurrency(b.Amt?.Ccy, o.currencyAliases),
    date: b.Dt?.Dt ?? b.Dt?.DtTm?.slice(0, 10) ?? null,
    dateTime: b.Dt?.DtTm ?? null,
  };
}

/** admi.002 rejection, or null if the document is not one. */
export function parseMessageReject(document: unknown): { code: BankErrorCode; bankCode: string; description: string | null } | null {
  const r = Admi002Document.safeParse(document);
  if (!r.success) return null;
  const rsn = r.data['admi.002.001.01'].Rsn;
  return {
    code: rsn.RjctgPtyRsn === '1010' ? 'DUPLICATE_MESSAGE_ID' : 'UNKNOWN',
    bankCode: rsn.RjctgPtyRsn,
    description: rsn.RsnDesc ?? null,
  };
}

/** camt.052 -> BalanceReport */
export function parseAccountReport(
  document: unknown,
  header: { BizMsgIdr?: string; CreDt?: string } = {},
  o: ParseOptions = {},
): BalanceReport {
  const doc = parseWith(Camt052Document, 'camt.052', document);
  const rpt = doc.BkToCstmrAcctRpt.Rpt;
  return {
    country: o.country ?? null,
    bankMessageId: str(header.BizMsgIdr ?? doc.BkToCstmrAcctRpt.GrpHdr?.MsgId),
    reportId: str(rpt.Id),
    createdAt: header.CreDt ?? doc.BkToCstmrAcctRpt.GrpHdr?.CreDtTm ?? null,
    account: account(rpt.Acct, o),
    balances: arr(rpt.Bal).map((b) => balance(b, o)),
  };
}

/** camt.053 -> Statement */
export function parseStatement(document: unknown, header: { BizMsgIdr?: string; CreDt?: string } = {}, o: ParseOptions = {}): Statement {
  const doc = parseWith(Camt053Document, 'camt.053', document);
  const s = doc.BkToCstmrStmt.Stmt;
  const entries: Entry[] = arr(s.Ntry).map((n) => {
    const domain = n.BkTxCd?.Domn?.Cd ?? n.BkTxCd?.Prtry?.Cd ?? null;
    const sts = typeof n.Sts === 'string' ? n.Sts : (n.Sts?.Cd ?? null);
    return {
      reference: str(n.NtryRef),
      bankReference: str(n.AcctSvcrRef),
      endToEndId: arr(n.NtryDtls?.TxDtls)[0]?.Refs?.EndToEndId ?? null,
      creditDebit: creditDebit(n.CdtDbtInd),
      reversal: n.RvslInd ?? false,
      status: EntryStatusCodes.toDomain(sts),
      statusCode: sts,
      bookingDate: n.BookgDt?.Dt ?? n.BookgDt?.DtTm?.slice(0, 10) ?? null,
      valueDate: n.ValDt?.Dt ?? n.ValDt?.DtTm?.slice(0, 10) ?? null,
      transactionType: transactionType(domain),
      transactionTypeCode: domain,
      description: n.AddtlNtryInf ?? null,
      amount: str(n.Amt?.Amt),
      currency: normalizeCurrency(n.Amt?.Ccy, o.currencyAliases),
    };
  });
  return {
    format: 'CAMT053',
    country: o.country ?? null,
    bankMessageId: str(header.BizMsgIdr ?? doc.BkToCstmrStmt.GrpHdr?.MsgId),
    statementId: str(s.Id),
    sequenceNumber: str(s.ElctrncSeqNb),
    page: Number(s.StmtPgntn?.PgNb ?? 1),
    lastPage: s.StmtPgntn?.LastPgInd ?? true,
    createdAt: header.CreDt ?? doc.BkToCstmrStmt.GrpHdr?.CreDtTm ?? null,
    fromDateTime: s.FrToDt?.FrDtTm ?? null,
    toDateTime: s.FrToDt?.ToDtTm ?? null,
    account: account(s.Acct, o),
    balances: arr(s.Bal).map((b) => balance(b, o)),
    entries,
    interim: null,
    information: null,
    raw: null,
  };
}

function status(code: string | undefined | null): StatusFields {
  const s: PaymentStatusCode = PaymentStatusCodes.toDomain(code);
  return { status: s, statusCode: code ?? null, state: paymentState(s) };
}

/** Banks often report RJCT for "partial or total rejection"; the per-status counts tell them apart (SPEC IBK-STS-002). */
export function deriveState<T extends StatusFields>(level: T, counts: StatusCount[]): T {
  const states = new Set(counts.map((c) => c.state));
  return states.has('FAILED') && states.size > 1 ? { ...level, state: 'PARTIAL' } : level;
}

const counts = (xs: unknown): StatusCount[] =>
  arr(xs as { DtldNbOfTxs: string; DtldSts: string; DtldCtrlSum?: string }[]).map((n) => ({
    count: Number(n.DtldNbOfTxs),
    controlSum: str(n.DtldCtrlSum),
    ...status(n.DtldSts),
  }));

/** pain.002 -> PaymentStatusReport */
export function parsePaymentStatusReport(
  document: unknown,
  header: { BizMsgIdr?: string; CreDt?: string } = {},
  o: ParseOptions = {},
): PaymentStatusReport {
  const doc = parseWith(Pain002Document, 'pain.002', document);
  const rpt = doc.CstmrPmtStsRpt;
  const grp = rpt.OrgnlGrpInfAndSts;
  const grpCounts = counts(grp.NbOfTxsPerSts);
  return deriveState(
    {
      country: o.country ?? null,
      messageId: grp.OrgnlMsgId,
      reportId: rpt.GrpHdr.MsgId,
      bankMessageId: str(header.BizMsgIdr),
      createdAt: header.CreDt ?? null,
      originalCreatedAt: grp.OrgnlCreDtTm ?? null,
      numberOfTransactions: Number(grp.OrgnlNbOfTxs ?? 0),
      controlSum: str(grp.OrgnlCtrlSum),
      ...status(grp.GrpSts),
      statusInfo: arr(grp.StsRsnInf)[0]?.AddtlInf ?? null,
      countsByStatus: grpCounts,
      paymentInfos: arr(rpt.OrgnlPmtInfAndSts).map((p) => {
        const pCounts = counts(p.NbOfTxsPerSts);
        return deriveState(
          {
            paymentInfoId: p.OrgnlPmtInfId ?? null,
            ...status(p.PmtInfSts),
            statusInfo: arr(p.StsRsnInf)[0]?.AddtlInf ?? null,
            countsByStatus: pCounts,
            transactions: arr(p.TxInfAndSts).map((t) => {
              const ref = t.OrgnlTxRef;
              const amt = ref?.Amt?.InstdAmt;
              const reason = arr(t.StsRsnInf)[0];
              const acctId = ref?.CdtrAcct?.Id as { IBAN?: string; Othr?: { Id?: string } } | undefined;
              return {
                endToEndId: t.OrgnlEndToEndId ?? null,
                ...status(t.TxSts),
                reasonCode: str(reason?.Rsn?.Cd ?? reason?.Rsn?.Prtry),
                statusInfo: reason?.AddtlInf ?? null,
                requestedExecutionDate: ref?.ReqdExctnDt ?? null,
                creditorName: ref?.Cdtr?.Nm ?? null,
                creditorAccount: {
                  ...(acctId?.Othr?.Id ? { number: acctId.Othr.Id } : {}),
                  ...(acctId?.IBAN ? { iban: acctId.IBAN } : {}),
                },
                creditorBankCode: ref?.CdtrAgt?.FinInstnId.ClrSysMmbId?.MmbId ?? null,
                creditorBankBic: ref?.CdtrAgt?.FinInstnId.BIC ?? null,
                amount: str(amt?.InstdAmt),
                currency: normalizeCurrency(amt?.['-Ccy'] ?? amt?.Ccy, o.currencyAliases),
              };
            }),
          },
          pCounts,
        );
      }),
    },
    grpCounts,
  );
}

/** admi.004 -> submission acknowledgement fields */
export function parseSystemEvent(document: unknown): { eventCode: string; description: string | null; eventTime: string | null } {
  const doc = parseWith(Admi004Document, 'admi.004', document);
  const e = doc.SysEvtNtfctn.EvtInf;
  return { eventCode: e.EvtCd, description: e.EvtDesc ?? null, eventTime: e.EvtTm ?? null };
}

/**
 * pain.001 -> PaymentBatch (first PmtInf). Route is inferred: a creditor BIC means CROSS_BORDER,
 * a clearing code listed in `intrabankCodes` means INTRABANK, any other clearing code DOMESTIC_CLEARING.
 */
export function parseCustomerCreditTransferInitiation(
  document: unknown,
  o: { intrabankCodes?: readonly string[] } = {},
): import('./model.js').PaymentBatch {
  const doc = parseWith(Pain001Document, 'pain.001', document);
  const init = doc.CstmrCdtTrfInitn;
  const pmt = init.PmtInf[0];
  if (!pmt) throw new MessageParseError('pain.001', []);
  const acct = (id: unknown) => {
    const a = id as { IBAN?: string; Othr?: { Id?: string } };
    return a.IBAN ? { iban: a.IBAN } : { number: a.Othr?.Id ?? '' };
  };
  const method = pmt.PmtMtd === 'CHK' ? 'CHECK' : 'TRANSFER';
  const purpose = pmt.PmtTpInf?.CtgyPurp?.Cd === 'SALA' ? 'PAYROLL' : 'SUPPLIERS';
  return {
    messageId: init.GrpHdr.MsgId,
    paymentInfoId: pmt.PmtInfId,
    country: pmt.DbtrAgt.FinInstnId.PstlAdr?.Ctry ?? '',
    debtorName: pmt.Dbtr.Nm,
    debtorAccount: acct(pmt.DbtrAcct.Id),
    requestedExecutionDate: pmt.ReqdExctnDt,
    method,
    purpose,
    transfers: pmt.CdtTrfTxInf.map((t) => {
      const fin = t.CdtrAgt?.FinInstnId;
      const code = fin?.ClrSysMmbId?.MmbId;
      const bic = fin?.BIC ?? fin?.BICFI;
      const route = bic ? 'CROSS_BORDER' : code && !o.intrabankCodes?.includes(code) ? 'DOMESTIC_CLEARING' : 'INTRABANK';
      const amt = t.Amt.InstdAmt as { InstdAmt: string; Ccy?: string; '-Ccy'?: string };
      const othr = t.Cdtr.Id?.OrgId.Othr;
      const creditorId = Array.isArray(othr) ? othr[0]?.Id : othr?.Id;
      const adr = t.Cdtr.PstlAdr;
      const accountType = t.CdtrAcct.Tp ? AccountTypeCodes.toDomain(t.CdtrAcct.Tp.Cd) : null;
      return {
        endToEndId: t.PmtId.EndToEndId,
        route,
        amount: amt.InstdAmt,
        currency: amt.Ccy ?? amt['-Ccy'] ?? '',
        creditor: {
          name: t.Cdtr.Nm,
          ...(creditorId ? { id: creditorId } : {}),
          ...(adr
            ? { address: { town: adr.TwnNm, country: adr.Ctry, line: Array.isArray(adr.AdrLine) ? adr.AdrLine.join(' ') : adr.AdrLine } }
            : {}),
        },
        creditorAccount: acct(t.CdtrAcct.Id),
        ...(accountType && accountType !== 'UNKNOWN' ? { creditorAccountType: accountType } : {}),
        ...(code ? { creditorBankCode: code } : {}),
        ...(bic ? { creditorBankBic: bic } : {}),
        ...(t.Purp?.Prtry ? { purposeCode: t.Purp.Prtry } : {}),
        ...(t.RmtInf ? { references: t.RmtInf.Strd.RfrdDocInf.map((r) => r.Nb) } : {}),
      } satisfies import('./model.js').Transfer;
    }),
  };
}
