// Bank-side documents: what an account-servicing bank sends back. Used by the simulator and by
// anyone building a test double for their own integration.

import { accountIdentification } from './build.js';
import { BalanceTypeCodes, CreditDebitCodes, PaymentStatusCodes } from './codes.js';
import type { AccountRef, BalanceType, CreditDebit, PaymentStatusCode } from './model.js';
import { sumAmounts } from './validate.js';

export interface BankBalance {
  type: Exclude<BalanceType, 'UNKNOWN'>;
  creditDebit: Exclude<CreditDebit, 'UNKNOWN'>;
  amount: string;
  date?: string;
  dateTime?: string;
}

export interface BankEntry {
  reference: string;
  amount: string;
  creditDebit: Exclude<CreditDebit, 'UNKNOWN'>;
  bookingDate: string;
  valueDate: string;
  /** 3-char SWIFT transaction type code, e.g. TRF. */
  transactionType: string;
  description?: string;
  endToEndId?: string;
}

const balanceDoc = (b: BankBalance, currency: string) => ({
  Tp: { CdOrPrtry: { Cd: BalanceTypeCodes.toIso(b.type) } },
  CdtDbtInd: CreditDebitCodes.toIso(b.creditDebit),
  Dt: b.dateTime ? { DtTm: b.dateTime } : { Dt: b.date },
  Amt: { Ccy: currency, Amt: b.amount },
});

/** camt.052 account report. */
export function buildAccountReportDocument(a: {
  messageId: string;
  createdAt: string;
  reportId: string;
  account: AccountRef;
  currency: string;
  balances: BankBalance[];
}) {
  return {
    BkToCstmrAcctRpt: {
      GrpHdr: { MsgId: a.messageId, CreDtTm: a.createdAt },
      Rpt: {
        Id: a.reportId,
        RptPgntn: { PgNb: '1', LastPgInd: 'true' },
        Acct: { Id: accountIdentification(a.account), Ccy: a.currency },
        Bal: a.balances.map((b) => balanceDoc(b, a.currency)),
      },
    },
  };
}

/** camt.053 statement. */
export function buildStatementDocument(a: {
  messageId: string;
  createdAt: string;
  statementId: string;
  sequenceNumber: number;
  account: AccountRef;
  currency: string;
  fromDateTime: string;
  toDateTime: string;
  balances: BankBalance[];
  entries: BankEntry[];
}) {
  return {
    BkToCstmrStmt: {
      GrpHdr: { MsgId: a.messageId, CreDtTm: a.createdAt },
      Stmt: {
        Id: a.statementId,
        StmtPgntn: { PgNb: '1', LastPgInd: 'true' },
        ElctrncSeqNb: a.sequenceNumber,
        FrToDt: { FrDtTm: a.fromDateTime, ToDtTm: a.toDateTime },
        Acct: { Id: accountIdentification(a.account), Ccy: a.currency },
        Bal: a.balances.map((b) => balanceDoc(b, a.currency)),
        Ntry: a.entries.map((e) => ({
          NtryRef: e.reference,
          Amt: { Amt: e.amount, Ccy: a.currency },
          CdtDbtInd: CreditDebitCodes.toIso(e.creditDebit),
          Sts: { Cd: 'BOOK' },
          BookgDt: { Dt: e.bookingDate },
          ValDt: { Dt: e.valueDate },
          BkTxCd: { Domn: { Cd: `N${e.transactionType}` } },
          ...(e.endToEndId ? { NtryDtls: { TxDtls: { Refs: { EndToEndId: e.endToEndId } } } } : {}),
          ...(e.description ? { AddtlNtryInf: e.description } : {}),
        })),
      },
    },
  };
}

export interface BankTransferStatus {
  endToEndId: string;
  status: Exclude<PaymentStatusCode, 'UNKNOWN'>;
  reasonCode: string;
  info: string;
  amount: string;
  currency: string;
  requestedExecutionDate: string;
  creditorName: string;
  creditorAccount: AccountRef;
  creditorBankCode?: string;
  creditorBankBic?: string;
}

/** pain.002 status report. Group/payment-info status follows the per-transfer statuses. */
export function buildPaymentStatusReportDocument(a: {
  reportId: string;
  createdAt: string;
  originalMessageId: string;
  originalCreatedAt: string;
  paymentInfoId: string;
  groupStatus: Exclude<PaymentStatusCode, 'UNKNOWN'>;
  groupInfo: string;
  transfers: BankTransferStatus[];
  currencyKey?: 'Ccy' | '-Ccy';
}) {
  const key = a.currencyKey ?? 'Ccy';
  const byStatus = new Map<string, BankTransferStatus[]>();
  for (const t of a.transfers) byStatus.set(t.status, [...(byStatus.get(t.status) ?? []), t]);
  const perSts = [...byStatus.entries()].map(([s, xs]) => ({
    DtldNbOfTxs: String(xs.length),
    DtldSts: PaymentStatusCodes.toIso(s as Exclude<PaymentStatusCode, 'UNKNOWN'>),
    DtldCtrlSum: sumAmounts(xs.map((x) => x.amount)),
  }));
  const ctrlSum = sumAmounts(a.transfers.map((t) => t.amount));
  const grpSts = PaymentStatusCodes.toIso(a.groupStatus);
  return {
    CstmrPmtStsRpt: {
      GrpHdr: { MsgId: a.reportId, CreDtTm: a.createdAt },
      OrgnlGrpInfAndSts: {
        OrgnlMsgId: a.originalMessageId,
        OrgnlMsgNmId: 'pain.001.001.03',
        OrgnlCreDtTm: a.originalCreatedAt,
        OrgnlNbOfTxs: String(a.transfers.length),
        OrgnlCtrlSum: ctrlSum,
        GrpSts: grpSts,
        StsRsnInf: { AddtlInf: a.groupInfo },
        NbOfTxsPerSts: perSts,
      },
      OrgnlPmtInfAndSts: {
        OrgnlPmtInfId: a.paymentInfoId,
        OrgnlNbOfTxs: String(a.transfers.length),
        OrgnlCtrlSum: ctrlSum,
        PmtInfSts: grpSts,
        StsRsnInf: { AddtlInf: a.groupInfo },
        NbOfTxsPerSts: perSts,
        TxInfAndSts: a.transfers.map((t) => ({
          StsId: PaymentStatusCodes.toIso(t.status),
          OrgnlEndToEndId: t.endToEndId,
          TxSts: PaymentStatusCodes.toIso(t.status),
          StsRsnInf: { Rsn: { Prtry: t.reasonCode }, AddtlInf: t.info },
          OrgnlTxRef: {
            Amt: { InstdAmt: { [key]: t.currency, InstdAmt: t.amount } },
            ReqdExctnDt: t.requestedExecutionDate,
            ...(t.creditorBankCode ? { CdtrAgt: { FinInstnId: { ClrSysMmbId: { MmbId: t.creditorBankCode } } } } : {}),
            ...(t.creditorBankBic ? { CdtrAgt: { FinInstnId: { BIC: t.creditorBankBic } } } : {}),
            Cdtr: { Nm: t.creditorName },
            CdtrAcct: { Id: accountIdentification(t.creditorAccount) },
          },
        })),
      },
    },
  };
}

/** admi.004 system event (e.g. RCVD acknowledgement). */
export function buildSystemEventDocument(a: { eventCode: string; description: string; eventTime: string }) {
  return { SysEvtNtfctn: { EvtInf: { EvtCd: a.eventCode, EvtDesc: a.description, EvtTm: a.eventTime } } };
}

/** admi.002 message reject. */
export function buildMessageRejectDocument(a: { reasonCode: string; description: string }) {
  return { 'admi.002.001.01': { Rsn: { RjctgPtyRsn: a.reasonCode, RsnDesc: a.description } } };
}
