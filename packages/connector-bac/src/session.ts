// A BAC session: builds envelopes, sends them through a transport (live HTTP or simulated wire),
// and parses BAC's responses into the domain model.
import { randomUUID } from 'node:crypto';
import type { BankSession } from '@iso20022-bank-kit/core';
import { BankError, classifyPaymentHttp, OUTCOME_UNKNOWN_GUIDANCE } from '@iso20022-bank-kit/core';
import {
  buildAccountReportingRequest,
  buildCustomerCreditTransferInitiation,
  buildStatusReportRequest,
  errorCategory,
  isoDateTime,
  type Parties,
  parseAccountReport,
  parseMessageReject,
  parsePaymentStatusReport,
  parseStatement,
  parseSystemEvent,
} from '@iso20022-bank-kit/iso20022';
import { mtToStatement } from '@iso20022-bank-kit/swift-mt';
import { BAC_CURRENCY_ALIASES, BAC_MESSAGE_PROFILE, type BacOperation, countryForBic, profileFor } from './profile.js';
import { decodeMtFile, unwrap, wrap } from './wire.js';

export interface BacTransport {
  post(operation: BacOperation, body: unknown): Promise<{ status: number; body: unknown; traceId?: string }>;
}

const requestId = () => randomUUID().replaceAll('-', '').slice(0, 20);

export function createBacSession(transport: BacTransport, bics: { clientBic: string; ownerBic: string }, now: () => Date): BankSession {
  const parties = (country: string): Parties => ({ ...bics, bankBic: profileFor(country).bankBic });
  const createdAt = (country: string) => isoDateTime(now(), profileFor(country).utcOffsetMinutes);

  async function read(operation: BacOperation, body: unknown) {
    const res = await transport.post(operation, body);
    const env = unwrap(res.body);
    const rejectDoc = env ? parseMessageReject(env.Document) : null;
    if (res.status < 200 || res.status >= 300 || rejectDoc) {
      throw new BankError(
        errorCategory(res.status >= 300 ? res.status : 400),
        rejectDoc?.description ?? `BAC returned HTTP ${res.status}`,
        {
          httpStatus: res.status,
          bankCode: rejectDoc?.bankCode ?? null,
          bankErrorCode: rejectDoc?.code ?? null,
          traceId: res.traceId ?? null,
        },
      );
    }
    return { res, env };
  }

  const parseOpts = (env: ReturnType<typeof unwrap>) => ({
    currencyAliases: BAC_CURRENCY_ALIASES,
    country: countryForBic(env?.AppHdr?.Fr?.FIId?.FinInstnId?.BICFI),
  });
  const hdr = (env: ReturnType<typeof unwrap>) => ({
    ...(env?.AppHdr?.BizMsgIdr ? { BizMsgIdr: env.AppHdr.BizMsgIdr } : {}),
    ...(env?.AppHdr?.CreDt ? { CreDt: env.AppHdr.CreDt } : {}),
  });

  return {
    async getBalance({ country, account }) {
      const msg = buildAccountReportingRequest({
        parties: parties(country),
        profile: BAC_MESSAGE_PROFILE,
        account,
        requestId: requestId(),
        createdAt: createdAt(country),
      });
      const { env } = await read('camt052', wrap(msg));
      return parseAccountReport(env?.Document, hdr(env), parseOpts(env));
    },

    async getStatement({ country, account, format, fromDate, toDate, fromTime, toTime }) {
      const msg = buildAccountReportingRequest({
        parties: parties(country),
        profile: BAC_MESSAGE_PROFILE,
        account,
        format,
        period: { fromDate, ...(toDate ? { toDate } : {}), ...(fromTime ? { fromTime } : {}), ...(toTime ? { toTime } : {}) },
        requestId: requestId(),
        createdAt: createdAt(country),
      });
      const op = format === 'CAMT053' ? 'camt053' : format === 'MT940' ? 'mt940' : 'mt942';
      const { res, env } = await read(op, wrap(msg));
      if (format === 'CAMT053') return parseStatement(env?.Document, hdr(env), parseOpts(env));
      const file = (res.body as { File?: string; file?: string }).File ?? (res.body as { file?: string }).file;
      if (typeof file !== 'string')
        throw new BankError('INTERNAL_ERROR', `BAC returned an unexpected ${format} payload`, { httpStatus: res.status });
      const text = decodeMtFile(file);
      return mtToStatement(text, { currencyAliases: BAC_CURRENCY_ALIASES, country: countryForBic(/\{1:F01([A-Z0-9]{8})/.exec(text)?.[1]) });
    },

    async getPaymentStatus({ country, messageId }) {
      const msg = buildStatusReportRequest({
        parties: parties(country),
        profile: BAC_MESSAGE_PROFILE,
        messageId,
        requestId: requestId(),
        createdAt: createdAt(country),
      });
      const { env } = await read('paymentStatus', wrap(msg));
      return parsePaymentStatusReport(env?.Document, hdr(env), parseOpts(env));
    },

    async initiatePayment(batch) {
      const profile = profileFor(batch.country);
      const msg = buildCustomerCreditTransferInitiation({
        parties: parties(batch.country),
        profile: BAC_MESSAGE_PROFILE,
        batch,
        createdAt: createdAt(batch.country),
        resolver: { intrabankClearingCode: () => profile.intrabankClearingCode },
      });
      // Exactly one attempt (SPEC IBK-PAY-001). Thrown transport errors are classified by the client.
      const res = await transport.post('initiatePayment', wrap(msg));
      const env = unwrap(res.body);
      const reject = env ? parseMessageReject(env.Document) : null;
      const classified = classifyPaymentHttp(batch.messageId, { status: res.status, reject }, errorCategory);
      if (classified) return classified;
      try {
        const evt = parseSystemEvent(env?.Document);
        return {
          result: 'SUBMITTED',
          messageId: batch.messageId,
          country: countryForBic(env?.AppHdr?.Fr?.FIId?.FinInstnId?.BICFI),
          ...evt,
        };
      } catch {
        // 2xx but not an acknowledgement we recognise: do not guess.
        return {
          result: 'OUTCOME_UNKNOWN',
          messageId: batch.messageId,
          category: 'INTERNAL_ERROR',
          httpStatus: res.status,
          detail: 'Unrecognised acknowledgement',
          guidance: OUTCOME_UNKNOWN_GUIDANCE,
        };
      }
    },
  };
}
