// BAC wire simulator: accepts the exact envelopes the live API would get, runs them against the
// shared simulation engine, and answers in BAC's response formats. Simulated mode therefore
// exercises the connector's real builders and parsers (SPEC IBK-PLG-004).

import type { SimulationEngine } from '@iso20022-bank-kit/core';
import { isSimFailure, TransportError } from '@iso20022-bank-kit/core';
import type { AccountRef } from '@iso20022-bank-kit/iso20022';
import {
  buildAccountReportDocument,
  buildMessageRejectDocument,
  buildPaymentStatusReportDocument,
  buildStatementDocument,
  buildSystemEventDocument,
  Camt060Document,
  isoDateTime,
  parseCustomerCreditTransferInitiation,
  Tsmt038Document,
} from '@iso20022-bank-kit/iso20022';
import { writeMt } from '@iso20022-bank-kit/swift-mt';
import { BAC_COUNTRIES, type BacOperation, countryForBic } from './profile.js';
import type { BacTransport } from './session.js';
import { encodeMtFile, unwrap } from './wire.js';

const reject = (status: number, reasonCode: string, description: string) => ({
  status,
  body: { File: { Envelope: { Document: buildMessageRejectDocument({ reasonCode, description }) } } },
});

export function createBacSimulatedTransport(sim: SimulationEngine): BacTransport {
  const respond = (bankBic: string, clientBic: string, msgDefIdr: string, document: unknown) => {
    const id = sim.nextId();
    return {
      status: 200,
      body: {
        File: {
          Envelope: {
            AppHdr: {
              Fr: { FIId: { FinInstnId: { BICFI: bankBic } } },
              To: { FIId: { FinInstnId: { BICFI: clientBic } } },
              BizMsgIdr: id,
              MsgDefIdr: msgDefIdr,
              BizSvc: 'swift.cbprplus.02',
              CreDt: isoDateTime(sim.now(), -360),
            },
            Document: document,
          },
        },
      },
    };
  };

  return {
    async post(operation: BacOperation, body: unknown) {
      const env = unwrap(body) as {
        AppHdr: { To: { FIId: { FinInstnId: { BICFI: string } } }; Fr: { FIId: { FinInstnId: { BICFI: string } } } };
        Document: unknown;
      } | null;
      if (!env?.AppHdr || !env.Document) return reject(400, 'MOCK-400', 'Invalid message structure (simulated)');
      const bankBic = env.AppHdr.To.FIId.FinInstnId.BICFI;
      const clientBic = env.AppHdr.Fr.FIId.FinInstnId.BICFI;
      const country = countryForBic(bankBic);
      if (!country) return reject(400, 'MOCK-400', 'Unknown bank BIC (simulated)');
      const now = isoDateTime(sim.now(), -360);

      if (operation === 'initiatePayment') {
        const batch = parseCustomerCreditTransferInitiation(env.Document, {
          intrabankCodes: BAC_COUNTRIES.map((c) => c.intrabankClearingCode ?? ''),
        });
        const r = sim.submitPayment(batch);
        switch (r.kind) {
          case 'accepted':
            return respond(
              bankBic,
              clientBic,
              'ADMIN.004.001.02',
              buildSystemEventDocument({
                eventCode: 'RCVD',
                description: 'Request received. Your payment is being processed (simulated).',
                eventTime: r.eventTime,
              }),
            );
          case 'duplicate':
          case 'rejected':
            return reject(r.httpStatus, r.reasonCode, r.description);
          case 'server_error':
            return { status: 500, body: { httpCode: '500', httpMessage: 'Internal Server Error' } };
          case 'unavailable':
            return { status: 503, body: null };
          case 'timeout':
            throw new TransportError('TIMEOUT', 'Timed out calling /transaction/initiate (simulated)');
        }
      }

      if (operation === 'paymentStatus') {
        const req = Tsmt038Document.safeParse(env.Document);
        if (!req.success) return reject(400, 'MOCK-400', 'Invalid message structure (simulated)');
        const s = sim.paymentStatus(req.data.StsRptReq.ReqId.Id);
        if (isSimFailure(s)) return reject(s.httpStatus, s.reasonCode, s.description);
        return respond(
          bankBic,
          clientBic,
          s.messageId,
          buildPaymentStatusReportDocument({
            reportId: `L-${s.messageId}`,
            createdAt: now,
            originalMessageId: s.messageId,
            originalCreatedAt: s.createdAt,
            paymentInfoId: s.paymentInfoId,
            groupStatus: s.groupStatus,
            groupInfo: s.groupInfo,
            currencyKey: '-Ccy',
            transfers: s.transfers.map((t) => ({ ...t, requestedExecutionDate: s.requestedExecutionDate })),
          }),
        );
      }

      const req = Camt060Document.safeParse(env.Document);
      if (!req.success) return reject(400, 'MOCK-400', 'Invalid message structure (simulated)');
      const r = req.data.AcctRptgReq.RptgReq;
      const account = r.Acct.Id as AccountRef & { Othr?: { Id: string }; IBAN?: string };
      const acct: AccountRef = account.IBAN ? { iban: account.IBAN } : { number: account.Othr?.Id ?? '' };

      if (operation === 'camt052') {
        const b = sim.balance(country, acct);
        if (isSimFailure(b)) return reject(b.httpStatus, b.reasonCode, b.description);
        return respond(
          bankBic,
          clientBic,
          'AccountBalanceReportV08',
          buildAccountReportDocument({
            messageId: sim.nextId(),
            createdAt: now,
            reportId: sim.nextId(),
            account: acct,
            currency: b.currency,
            balances: [{ type: 'INTERIM_AVAILABLE', creditDebit: b.available.creditDebit, amount: b.available.amount, dateTime: now }],
          }),
        );
      }

      const from = r.RptgPrd?.FrToDt.FrDt ?? now.slice(0, 10);
      const to = r.RptgPrd?.FrToDt.ToDt ?? from;
      const st = sim.statement(country, acct, from, to);
      if (isSimFailure(st)) return reject(st.httpStatus, st.reasonCode, st.description);
      if (operation === 'camt053') {
        return respond(
          bankBic,
          clientBic,
          'camt.053.001.08',
          buildStatementDocument({
            messageId: sim.nextId(),
            createdAt: now,
            statementId: sim.nextId(),
            sequenceNumber: Number(sim.nextId()),
            account: acct,
            currency: st.currency,
            fromDateTime: `${from}T00:00:00+00:00`,
            toDateTime: `${to}T23:59:59+00:00`,
            balances: [
              { type: 'OPENING_BOOKED', creditDebit: st.opening.creditDebit, amount: st.opening.amount, date: from },
              { type: 'CLOSING_BOOKED', creditDebit: st.closing.creditDebit, amount: st.closing.amount, date: to },
            ],
            entries: st.entries.map((e) => ({ ...e, ...(e.endToEndId ? { endToEndId: e.endToEndId } : {}) })),
          }),
        );
      }

      const cd = (x: 'CREDIT' | 'DEBIT') => (x === 'CREDIT' ? ('CRDT' as const) : ('DBIT' as const));
      const text = writeMt({
        messageType: operation === 'mt940' ? 'MT940' : 'MT942',
        senderBic: bankBic,
        receiverBic: clientBic,
        transactionReference: `${to.replaceAll('-', '').slice(4)}${sim.nextId().padStart(12, '0')}`,
        account: acct.iban ?? acct.number ?? '',
        sequence: `${to.slice(5, 7)}${to.slice(8, 10)}/1`,
        currency: st.currency,
        opening: { creditDebit: cd(st.opening.creditDebit), date: from, amount: st.opening.amount },
        closing: { creditDebit: cd(st.closing.creditDebit), date: to, amount: st.closing.amount },
        available: { creditDebit: cd(st.closing.creditDebit), date: to, amount: st.closing.amount },
        entries: st.entries.map((e) => ({ ...e, creditDebit: cd(e.creditDebit) })),
        reportDateTime: sim.now().toISOString(),
        information: 'SIMULATED',
      });
      return { status: 200, body: { File: encodeMtFile(text) } };
    },
  };
}
