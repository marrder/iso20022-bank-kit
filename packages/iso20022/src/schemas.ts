// Zod schemas for the ISO 20022 JSON documents this kit builds and reads (CBPR+-style JSON,
// element names as in the ISO XSDs). Objects are "loose": unknown elements pass through, because
// banks add proprietary ones. These schemas also produce the published JSON Schemas.
import * as z from 'zod';

const text = (max: number) => z.string().min(1).max(max);
const num = z.union([z.string(), z.number()]).transform((v) => String(v));
const bool = z.union([z.boolean(), z.literal('true'), z.literal('false')]).transform((v) => v === true || v === 'true');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T/);
const one = <T extends z.ZodType>(s: T) => z.union([s, z.array(s)]);

export const BicFi = z.string().regex(/^[A-Z0-9]{4,11}$/, 'BIC or bank-assigned alias');

export const FinInstnId = z.looseObject({
  BICFI: BicFi.optional(),
  BIC: BicFi.optional(),
  ClrSysMmbId: z.looseObject({ MmbId: text(35) }).optional(),
  PstlAdr: z.looseObject({ Ctry: z.string().length(2) }).optional(),
});

export const AccountIdentification = z.union([
  z.looseObject({ IBAN: z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/) }),
  z.looseObject({ Othr: z.looseObject({ Id: text(34) }) }),
]);

/** head.001 Business Application Header. */
export const AppHdr = z.looseObject({
  Fr: z.looseObject({ FIId: z.looseObject({ FinInstnId }) }),
  To: z.looseObject({ FIId: z.looseObject({ FinInstnId }) }),
  BizMsgIdr: text(35),
  MsgDefIdr: text(35),
  BizSvc: text(35).optional(),
  CreDt: dateTime,
});

// ------------------------------------------------------------------ requests

/** camt.060.001.05 AccountReportingRequest */
export const Camt060Document = z.looseObject({
  xmlns: z.string().optional(),
  AcctRptgReq: z.looseObject({
    GrpHdr: z.looseObject({ MsgId: text(35), CreDtTm: dateTime }),
    RptgReq: z.looseObject({
      ReqdMsgNmId: text(35),
      Acct: z.looseObject({ Id: AccountIdentification }),
      AcctOwnr: z.looseObject({ Agt: z.looseObject({ FinInstnId }) }),
      RptgPrd: z
        .looseObject({
          FrToDt: z.looseObject({ FrDt: date, ToDt: date.optional() }),
          FrToTm: z.looseObject({ FrTm: z.string(), ToTm: z.string().optional() }).optional(),
          Tp: z.enum(['ALLL', 'CHNG', 'MODF']),
        })
        .optional(),
      RptgSeq: z.looseObject({ EQSeq: z.string() }).optional(),
    }),
  }),
});

/** tsmt.038.001.03 StatusReportRequest */
export const Tsmt038Document = z.looseObject({
  xmlns: z.string().optional(),
  StsRptReq: z.looseObject({
    ReqId: z.looseObject({ Id: text(35), CreDtTm: dateTime }),
    NttiesToBeRptd: z.looseObject({ BIC: BicFi }),
  }),
});

const InstdAmt = z
  .looseObject({ InstdAmt: num })
  .and(z.union([z.looseObject({ '-Ccy': z.string().length(3) }), z.looseObject({ Ccy: z.string().length(3) })]));

export const CreditTransferTransaction = z.looseObject({
  PmtId: z.looseObject({ EndToEndId: text(35) }),
  PmtTpInf: z.looseObject({ InstrPrty: z.enum(['NORM', 'HIGH']) }).optional(),
  Amt: z.looseObject({ InstdAmt }),
  CdtrAgt: z.looseObject({ FinInstnId }).optional(),
  Cdtr: z.looseObject({
    Nm: text(140),
    PstlAdr: z.looseObject({ TwnNm: text(35), Ctry: z.string().length(2), AdrLine: z.union([text(70), z.array(text(70))]) }).optional(),
    Id: z.looseObject({ OrgId: z.looseObject({ Othr: one(z.looseObject({ Id: text(35) })) }) }).optional(),
  }),
  CdtrAcct: z.looseObject({ Id: AccountIdentification, Tp: z.looseObject({ Cd: z.string() }).optional() }),
  Purp: z.looseObject({ Prtry: text(35) }).optional(),
  RmtInf: z.looseObject({ Strd: z.looseObject({ RfrdDocInf: z.array(z.looseObject({ Nb: text(35) })) }) }).optional(),
});

/** pain.001.001.03 CustomerCreditTransferInitiation */
export const Pain001Document = z.looseObject({
  CstmrCdtTrfInitn: z.looseObject({
    GrpHdr: z.looseObject({
      MsgId: text(35),
      CreDtTm: z.string(),
      NbOfTxs: num,
      CtrlSum: num.optional(),
      InitgPty: z.looseObject({ Nm: text(140).optional() }),
    }),
    PmtInf: z
      .array(
        z.looseObject({
          PmtInfId: text(35),
          PmtMtd: z.enum(['TRF', 'CHK', 'TRA']),
          NbOfTxs: num.optional(),
          CtrlSum: num.optional(),
          PmtTpInf: z.looseObject({ CtgyPurp: z.looseObject({ Cd: z.string() }).optional() }).optional(),
          ReqdExctnDt: date,
          Dbtr: z.looseObject({ Nm: text(140) }),
          DbtrAcct: z.looseObject({ Id: AccountIdentification }),
          DbtrAgt: z.looseObject({ FinInstnId }),
          CdtTrfTxInf: z.array(CreditTransferTransaction).min(1),
        }),
      )
      .min(1),
  }),
});

// ------------------------------------------------------------------ responses

const ActiveAmount = z.looseObject({ Amt: num.optional(), Ccy: z.string().optional() });

export const CashBalance = z.looseObject({
  Tp: z.looseObject({ CdOrPrtry: z.looseObject({ Cd: z.string().optional(), Prtry: z.string().optional() }) }).optional(),
  CdtDbtInd: z.string().optional(),
  Dt: z.looseObject({ Dt: date.optional(), DtTm: dateTime.optional() }).optional(),
  Amt: ActiveAmount.optional(),
});

const CashAccount = z.looseObject({ Id: AccountIdentification, Ccy: z.string().optional() });

/** camt.052.001.08 BankToCustomerAccountReport */
export const Camt052Document = z.looseObject({
  BkToCstmrAcctRpt: z.looseObject({
    GrpHdr: z.looseObject({ MsgId: z.string(), CreDtTm: z.string().optional() }).optional(),
    Rpt: z.looseObject({ Id: num.optional(), Acct: CashAccount, Bal: one(CashBalance).optional() }),
  }),
});

export const ReportEntry = z.looseObject({
  NtryRef: num.optional(),
  AcctSvcrRef: num.optional(),
  Amt: ActiveAmount.optional(),
  CdtDbtInd: z.string().optional(),
  RvslInd: bool.optional(),
  Sts: z.union([z.string(), z.looseObject({ Cd: z.string() })]).optional(),
  BookgDt: z.looseObject({ Dt: date.optional(), DtTm: dateTime.optional() }).optional(),
  ValDt: z.looseObject({ Dt: date.optional(), DtTm: dateTime.optional() }).optional(),
  BkTxCd: z
    .looseObject({ Domn: z.looseObject({ Cd: z.string() }).optional(), Prtry: z.looseObject({ Cd: z.string() }).optional() })
    .optional(),
  NtryDtls: z
    .looseObject({ TxDtls: one(z.looseObject({ Refs: z.looseObject({ EndToEndId: z.string().optional() }).optional() })) })
    .optional(),
  AddtlNtryInf: z.string().optional(),
});

/** camt.053.001.08 BankToCustomerStatement */
export const Camt053Document = z.looseObject({
  BkToCstmrStmt: z.looseObject({
    GrpHdr: z.looseObject({ MsgId: z.string(), CreDtTm: z.string().optional() }).optional(),
    Stmt: z.looseObject({
      Id: num.optional(),
      ElctrncSeqNb: num.optional(),
      StmtPgntn: z.looseObject({ PgNb: num, LastPgInd: bool }).optional(),
      FrToDt: z.looseObject({ FrDtTm: z.string().optional(), ToDtTm: z.string().optional() }).optional(),
      Acct: CashAccount,
      Bal: one(CashBalance).optional(),
      Ntry: one(ReportEntry).optional(),
    }),
  }),
});

const StatusReason = z.looseObject({
  Rsn: z.looseObject({ Cd: z.string().optional(), Prtry: num.optional() }).optional(),
  AddtlInf: z.string().optional(),
});
const NbOfTxsPerSts = z.looseObject({ DtldNbOfTxs: num, DtldSts: z.string(), DtldCtrlSum: num.optional() });

/** pain.002.001.03 CustomerPaymentStatusReport */
export const Pain002Document = z.looseObject({
  CstmrPmtStsRpt: z.looseObject({
    GrpHdr: z.looseObject({ MsgId: z.string() }),
    OrgnlGrpInfAndSts: z.looseObject({
      OrgnlMsgId: z.string(),
      OrgnlCreDtTm: z.string().optional(),
      OrgnlNbOfTxs: num.optional(),
      OrgnlCtrlSum: num.optional(),
      GrpSts: z.string().optional(),
      StsRsnInf: one(StatusReason).optional(),
      NbOfTxsPerSts: one(NbOfTxsPerSts).optional(),
    }),
    OrgnlPmtInfAndSts: one(
      z.looseObject({
        OrgnlPmtInfId: z.string().optional(),
        PmtInfSts: z.string().optional(),
        StsRsnInf: one(StatusReason).optional(),
        NbOfTxsPerSts: one(NbOfTxsPerSts).optional(),
        TxInfAndSts: one(
          z.looseObject({
            OrgnlEndToEndId: z.string().optional(),
            TxSts: z.string().optional(),
            StsRsnInf: one(StatusReason).optional(),
            OrgnlTxRef: z
              .looseObject({
                Amt: z
                  .looseObject({
                    InstdAmt: z.looseObject({ InstdAmt: num.optional(), '-Ccy': z.string().optional(), Ccy: z.string().optional() }),
                  })
                  .optional(),
                ReqdExctnDt: date.optional(),
                CdtrAgt: z.looseObject({ FinInstnId }).optional(),
                Cdtr: z.looseObject({ Nm: z.string().optional() }).optional(),
                CdtrAcct: z.looseObject({ Id: AccountIdentification }).optional(),
              })
              .optional(),
          }),
        ).optional(),
      }),
    ).optional(),
  }),
});

/** admi.004.001.02 SystemEventNotification */
export const Admi004Document = z.looseObject({
  SysEvtNtfctn: z.looseObject({
    EvtInf: z.looseObject({ EvtCd: z.string(), EvtDesc: z.string().optional(), EvtTm: z.string().optional() }),
  }),
});

/** admi.002.001.01 MessageReject */
export const Admi002Document = z.looseObject({
  'admi.002.001.01': z.looseObject({
    Rsn: z.looseObject({ RjctgPtyRsn: num, RsnDesc: z.string().optional() }),
  }),
});

/** Every message this kit understands, keyed by ISO message identifier. */
export const MESSAGE_SCHEMAS = {
  'head.001.001.02': AppHdr,
  'camt.060.001.05': Camt060Document,
  'tsmt.038.001.03': Tsmt038Document,
  'pain.001.001.03': Pain001Document,
  'camt.052.001.08': Camt052Document,
  'camt.053.001.08': Camt053Document,
  'pain.002.001.03': Pain002Document,
  'admi.004.001.02': Admi004Document,
  'admi.002.001.01': Admi002Document,
} as const;

export type MessageId = keyof typeof MESSAGE_SCHEMAS;

/** Detects which document a JSON object is, from its root element. */
export function detectMessage(document: unknown): MessageId | null {
  if (!document || typeof document !== 'object') return null;
  const roots: Record<string, MessageId> = {
    AcctRptgReq: 'camt.060.001.05',
    StsRptReq: 'tsmt.038.001.03',
    CstmrCdtTrfInitn: 'pain.001.001.03',
    BkToCstmrAcctRpt: 'camt.052.001.08',
    BkToCstmrStmt: 'camt.053.001.08',
    CstmrPmtStsRpt: 'pain.002.001.03',
    SysEvtNtfctn: 'admi.004.001.02',
    'admi.002.001.01': 'admi.002.001.01',
  };
  for (const key of Object.keys(document)) if (roots[key]) return roots[key];
  return null;
}

/** JSON Schema (draft 2020-12) for one message. */
export function jsonSchemaFor(id: MessageId): Record<string, unknown> {
  return z.toJSONSchema(MESSAGE_SCHEMAS[id], { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}
