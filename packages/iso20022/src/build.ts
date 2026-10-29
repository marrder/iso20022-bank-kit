// Builds ISO 20022 business messages ({ AppHdr, Document }) from the domain model.
// Bank-specific choices (BICs, header conventions, currency attribute key) come in as a profile,
// so connectors stay thin (SPEC IBK-PLG-003).
import { AccountTypeCodes, CategoryPurposeCodes, PaymentMethodCodes } from './codes.js';
import type { AccountRef, PaymentBatch, StatementFormat, Transfer } from './model.js';
import { sumAmounts } from './validate.js';

export interface BusinessMessage<D = Record<string, unknown>> {
  AppHdr: Record<string, unknown>;
  Document: D;
}

export interface Parties {
  /** BIC/alias of the sending client application (AppHdr.Fr). */
  clientBic: string;
  /** BIC/alias of the account owner / initiating party. */
  ownerBic: string;
  /** BIC of the account-servicing bank (AppHdr.To, DbtrAgt). */
  bankBic: string;
}

export interface MessageProfile {
  /** AppHdr.BizSvc, e.g. "swift.cbprplus.01". */
  bizSvc: string;
  /** AppHdr.MsgDefIdr per message; banks sometimes use their own aliases. */
  msgDefIdr: { camt060: string; tsmt038: string; pain001: string };
  /** camt.060 ReqdMsgNmId per report kind. */
  reqdMsgNmId: { balance: string } & Record<StatementFormat, string>;
  /** Key carrying the currency next to InstdAmt: "Ccy" (ISO JSON) or "-Ccy" (XML-attribute style). */
  currencyKey: 'Ccy' | '-Ccy';
  /** Include `xmlns` on documents that carry it. */
  includeXmlns: boolean;
  /** Countries where creditor account type must not be sent. */
  omitAccountTypeIn?: readonly string[];
}

export const DEFAULT_PROFILE: MessageProfile = {
  bizSvc: 'swift.cbprplus.01',
  msgDefIdr: { camt060: 'camt.060.001.05', tsmt038: 'tsmt.038.001.03', pain001: 'pain.001.001.03' },
  reqdMsgNmId: { balance: 'camt.052.001.08', CAMT053: 'camt.053.001.08', MT940: 'MT940', MT942: 'MT942' },
  currencyKey: 'Ccy',
  includeXmlns: true,
};

/** Formats a date-time in a fixed UTC offset, e.g. 2026-01-02T08:00:00-06:00. */
export function isoDateTime(date: Date, offsetMinutes = 0): string {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${local.toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function accountIdentification(account: AccountRef): Record<string, unknown> {
  if (account.iban) return { IBAN: account.iban.replace(/\s+/g, '').toUpperCase() };
  if (account.number) return { Othr: { Id: account.number } };
  throw new TypeError('AccountRef needs number or iban');
}

function appHdr(parties: Parties, profile: MessageProfile, bizMsgIdr: string, msgDefIdr: string, creDt: string) {
  return {
    Fr: { FIId: { FinInstnId: { BICFI: parties.clientBic } } },
    To: { FIId: { FinInstnId: { BICFI: parties.bankBic } } },
    BizMsgIdr: bizMsgIdr,
    MsgDefIdr: msgDefIdr,
    BizSvc: profile.bizSvc,
    CreDt: creDt,
  };
}

const xmlns = (profile: MessageProfile, id: string) => (profile.includeXmlns ? { xmlns: `urn:iso:std:iso:20022:tech:xsd:${id}` } : {});

export interface ReportPeriod {
  fromDate: string;
  toDate?: string;
  /** Intraday window (MT942 / interim reports). */
  fromTime?: string;
  toTime?: string;
}

/** camt.060: requests a balance report (no format) or a statement in `format`. */
export function buildAccountReportingRequest(args: {
  parties: Parties;
  profile?: MessageProfile;
  account: AccountRef;
  format?: StatementFormat;
  period?: ReportPeriod;
  requestId: string;
  createdAt: string;
}): BusinessMessage {
  const profile = args.profile ?? DEFAULT_PROFILE;
  const rptgReq: Record<string, unknown> = {
    ReqdMsgNmId: args.format ? profile.reqdMsgNmId[args.format] : profile.reqdMsgNmId.balance,
    Acct: { Id: accountIdentification(args.account) },
    AcctOwnr: { Agt: { FinInstnId: { BICFI: args.parties.ownerBic } } },
  };
  if (args.format) {
    const p = args.period;
    if (!p) throw new TypeError('A statement request needs a period');
    const prd: Record<string, unknown> = { FrToDt: { FrDt: p.fromDate, ToDt: p.toDate ?? p.fromDate } };
    if (args.format === 'MT942' || p.fromTime || p.toTime)
      prd.FrToTm = { FrTm: p.fromTime ?? '00:00:00.000', ToTm: p.toTime ?? '23:59:59.000' };
    prd.Tp = 'ALLL';
    rptgReq.RptgPrd = prd;
    rptgReq.RptgSeq = { EQSeq: '1' };
  }
  return {
    AppHdr: appHdr(args.parties, profile, args.requestId, profile.msgDefIdr.camt060, args.createdAt),
    Document: {
      ...xmlns(profile, 'camt.060.001.05'),
      AcctRptgReq: { GrpHdr: { MsgId: args.requestId, CreDtTm: args.createdAt }, RptgReq: rptgReq },
    },
  };
}

/** tsmt.038: asks for the pain.002 status of the batch identified by `messageId`. */
export function buildStatusReportRequest(args: {
  parties: Parties;
  profile?: MessageProfile;
  messageId: string;
  requestId: string;
  createdAt: string;
}): BusinessMessage {
  const profile = args.profile ?? DEFAULT_PROFILE;
  return {
    AppHdr: appHdr(args.parties, profile, args.requestId, profile.msgDefIdr.tsmt038, args.createdAt),
    Document: {
      ...xmlns(profile, 'tsmt.038.001.03'),
      StsRptReq: { ReqId: { Id: args.messageId, CreDtTm: args.createdAt }, NttiesToBeRptd: { BIC: args.parties.ownerBic } },
    },
  };
}

export interface CreditorAgentResolver {
  /** Clearing member id used for INTRABANK when the transfer gives none. */
  intrabankClearingCode?: (country: string) => string | undefined;
}

function creditorAgent(t: Transfer, country: string, resolver: CreditorAgentResolver) {
  switch (t.route) {
    case 'INTRABANK': {
      const code = t.creditorBankCode ?? resolver.intrabankClearingCode?.(country);
      return code ? { FinInstnId: { ClrSysMmbId: { MmbId: code } } } : undefined;
    }
    case 'DOMESTIC_CLEARING':
      return { FinInstnId: { ClrSysMmbId: { MmbId: t.creditorBankCode } } };
    case 'CROSS_BORDER':
      return { FinInstnId: { BIC: t.creditorBankBic } };
  }
}

function transaction(t: Transfer, country: string, profile: MessageProfile, resolver: CreditorAgentResolver) {
  const tx: Record<string, unknown> = {
    PmtId: { EndToEndId: t.endToEndId },
    PmtTpInf: { InstrPrty: 'NORM' },
    Amt: { InstdAmt: { [profile.currencyKey]: t.currency, InstdAmt: t.amount } },
  };
  const agent = creditorAgent(t, country, resolver);
  if (agent) tx.CdtrAgt = agent;
  const cdtr: Record<string, unknown> = { Nm: t.creditor.name };
  if (t.creditor.address)
    cdtr.PstlAdr = { TwnNm: t.creditor.address.town, Ctry: t.creditor.address.country, AdrLine: t.creditor.address.line };
  if (t.creditor.id) cdtr.Id = { OrgId: { Othr: [{ Id: t.creditor.id }] } };
  tx.Cdtr = cdtr;
  const acct: Record<string, unknown> = { Id: accountIdentification(t.creditorAccount) };
  if (t.creditorAccountType && !profile.omitAccountTypeIn?.includes(country))
    acct.Tp = { Cd: AccountTypeCodes.toIso(t.creditorAccountType) };
  tx.CdtrAcct = acct;
  if (t.purposeCode) tx.Purp = { Prtry: t.purposeCode };
  if (t.references?.length) tx.RmtInf = { Strd: { RfrdDocInf: t.references.map((Nb) => ({ Nb })) } };
  return tx;
}

/** pain.001: NbOfTxs and CtrlSum are always derived from the transfers (SPEC IBK-PAY-004). */
export function buildCustomerCreditTransferInitiation(args: {
  parties: Parties;
  profile?: MessageProfile;
  batch: PaymentBatch;
  createdAt: string;
  resolver?: CreditorAgentResolver;
}): BusinessMessage {
  const profile = args.profile ?? DEFAULT_PROFILE;
  const { batch, parties } = args;
  const ctrlSum = Number(sumAmounts(batch.transfers.map((t) => t.amount)));
  return {
    AppHdr: appHdr(parties, profile, batch.messageId, profile.msgDefIdr.pain001, args.createdAt),
    Document: {
      CstmrCdtTrfInitn: {
        GrpHdr: {
          MsgId: batch.messageId,
          CreDtTm: args.createdAt,
          NbOfTxs: batch.transfers.length,
          CtrlSum: ctrlSum,
          InitgPty: { Nm: batch.debtorName, Id: { OrgId: { BICOrBEI: parties.ownerBic } } },
        },
        PmtInf: [
          {
            PmtInfId: batch.paymentInfoId ?? batch.messageId,
            PmtMtd: PaymentMethodCodes.toIso(batch.method ?? 'TRANSFER'),
            NbOfTxs: batch.transfers.length,
            CtrlSum: ctrlSum,
            PmtTpInf: { CtgyPurp: { Cd: CategoryPurposeCodes.toIso(batch.purpose ?? 'SUPPLIERS') } },
            ReqdExctnDt: batch.requestedExecutionDate,
            Dbtr: { Nm: batch.debtorName },
            DbtrAcct: { Id: accountIdentification(batch.debtorAccount) },
            DbtrAgt: { FinInstnId: { BIC: parties.bankBic, PstlAdr: { Ctry: batch.country } } },
            CdtTrfTxInf: batch.transfers.map((t) => transaction(t, batch.country, profile, args.resolver ?? {})),
          },
        ],
      },
    },
  };
}
