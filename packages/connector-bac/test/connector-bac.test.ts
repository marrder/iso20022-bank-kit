import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  BAC_COUNTRIES,
  type BacTransport,
  bacConnector,
  createBacSession,
  createBacSimulatedTransport,
  decodeMtFile,
  encodeMtFile,
  unwrap,
  validateBacPayment,
} from '@iso20022-bank-kit/connector-bac';
import { ConnectionError, createBankClient } from '@iso20022-bank-kit/core';
import {
  parseAccountReport,
  parseMessageReject,
  parsePaymentStatusReport,
  parseStatement,
  parseSystemEvent,
} from '@iso20022-bank-kit/iso20022';
import { sampleBatch, simulationFor, yesterday } from '@iso20022-bank-kit/simulator';
import { mtToStatement } from '@iso20022-bank-kit/swift-mt';
import { describe, expect, it } from 'vitest';

const now = () => new Date();

/** Records what the session sends, while forwarding to the simulated wire. */
function recording() {
  const sent: { op: string; body: unknown }[] = [];
  const inner = createBacSimulatedTransport(simulationFor([bacConnector]));
  const transport: BacTransport = {
    post: (op, body) => {
      sent.push({ op, body });
      return inner.post(op, body);
    },
  };
  return { sent, session: createBacSession(transport, { clientBic: 'DUMMYMASTER', ownerBic: 'DUMMYORDENA' }, now) };
}

describe('BAC wire format', () => {
  it('wraps requests in file.Envelope with BAC header conventions', async () => {
    const { sent, session } = recording();
    await session.getBalance({ country: 'HN', account: { number: '999888666' } });
    await session.initiatePayment(
      sampleBatch('CR', 'CRC', {
        debtorAccount: { iban: 'CR41010200009998886660' },
        transfers: sampleBatch('CR', 'CRC').transfers.map((t) => ({
          ...t,
          creditorAccountType: 'SAVINGS',
          creditorAccount: t.route === 'CROSS_BORDER' ? t.creditorAccount : { iban: 'CR41010200009998886660' },
        })),
      }),
    );
    const env = (
      sent[0]!.body as {
        file: { Envelope: { AppHdr: Record<string, unknown>; Document: { AcctRptgReq: { RptgReq: Record<string, unknown> } } } };
      }
    ).file.Envelope;
    expect(env.AppHdr).toMatchObject({
      MsgDefIdr: 'camt.060.001.05',
      BizSvc: 'swift.cbprplus.01',
      To: { FIId: { FinInstnId: { BICFI: 'BMILHNTE' } } },
    });
    expect(env.AppHdr.CreDt).toMatch(/-06:00$/);
    expect(env.Document.AcctRptgReq.RptgReq.ReqdMsgNmId).toBe('AccountBalanceReportV08');
    const pay = JSON.stringify(sent[1]?.body);
    expect(pay).toContain('"MsgDefIdr":"PaymentInitiationServiceV03"');
    expect(pay).toContain('"-Ccy":"CRC"');
    expect(pay).not.toContain('"Tp":{"Cd":"SVGS"}');
    expect(pay).toContain('"MmbId":"102"');
  });
  it('uses UTC-5 for Panamá', async () => {
    const { sent, session } = recording();
    await session.getBalance({ country: 'PA', account: { number: '1' } });
    expect((sent[0]!.body as { file: { Envelope: { AppHdr: { CreDt: string } } } }).file.Envelope.AppHdr.CreDt).toMatch(/-05:00$/);
  });
  it('decodes and encodes MT payloads', () => {
    expect(decodeMtFile(encodeMtFile('{1:F01X}'))).toBe('{1:F01X}');
    expect(() => decodeMtFile('nope!')).toThrow(/F\{<base64>\}/);
  });
});

describe('BAC rules', () => {
  it('reference limits and El Salvador purpose codes', () => {
    const b = sampleBatch('HN', 'HNL');
    b.transfers[0] = { ...b.transfers[0]!, references: ['x'.repeat(20), 'y'.repeat(20)], purposeCode: '26.3' };
    b.transfers[2] = { ...b.transfers[2]!, references: ['z'.repeat(35), 'z'.repeat(35), 'z'.repeat(35), 'z'.repeat(35)] };
    const p = validateBacPayment(b);
    expect(p).toContain('transfers[0].references total 40 characters; INTRABANK allows 35 at BAC');
    expect(p).toContain('transfers[0].purposeCode applies to El Salvador only at BAC');
    expect(p.some((x) => x.startsWith('transfers[2]'))).toBe(false);
  });
  it('IBK-PLG-001: declares six countries with valid profiles', () => {
    expect(BAC_COUNTRIES.map((c) => c.code)).toEqual(['PA', 'CR', 'NI', 'HN', 'SV', 'GT']);
    expect(bacConnector.capabilities.statementFormats).toEqual(['CAMT053', 'MT940', 'MT942']);
  });
});

describe('live mode configuration', () => {
  const conn = { clientId: 'i', clientSecret: 's', clientBic: 'C', ownerBic: 'O' };
  const client = (allowedHosts = ['*.baccredomatic.com']) =>
    createBankClient({ connectors: [bacConnector], backend: 'live', allowedHosts });
  it('sandbox URLs are built in and allowlisted', () => {
    expect(() => client().session('bac', conn)).not.toThrow();
  });
  it('IBK-SEC-002: endpoint overrides must be allowlisted https', () => {
    expect(() => client().session('bac', { ...conn, endpoint: 'https://evil.example' })).toThrow(ConnectionError);
    expect(() => client().session('bac', { ...conn, endpoint: 'http://api.baccredomatic.com' })).toThrow(ConnectionError);
  });
  it('production needs explicit URLs; mTLS needs both halves', () => {
    expect(() => client().session('bac', { ...conn, environment: 'PRODUCTION' })).toThrow(/endpoint and tokenUrl/);
    expect(() => client().session('bac', { ...conn, mtlsCertificate: '-----BEGIN CERTIFICATE-----' })).toThrow(/together/);
  });
});

describe('simulated mode runs the real codecs (IBK-PLG-004)', () => {
  it('statements in all three formats agree', async () => {
    const { session } = recording();
    const fmt = async (format: 'CAMT053' | 'MT940' | 'MT942') =>
      (await session.getStatement({ country: 'GT', account: { number: '12345' }, format, fromDate: yesterday() })).entries.map((e) => [
        e.reference,
        Number(e.amount),
        e.creditDebit,
      ]);
    const camt = await fmt('CAMT053');
    expect(camt).toHaveLength(5);
    expect(await fmt('MT940')).toEqual(camt);
    expect(await fmt('MT942')).toEqual(camt);
  });
});

// Optional: BAC's own documentation examples, if you have them locally (not redistributable).
// Put the strict-JSON fixtures from lab tooling in fixtures/private/bac/*.json.
const privateDir = new URL('../../../fixtures/private/bac/', import.meta.url);
const hasPrivate = existsSync(privateDir) && readdirSync(privateDir).some((f) => f.endsWith('.json'));
describe.skipIf(!hasPrivate)('BAC documentation examples (private fixtures)', () => {
  const load = (name: string) => JSON.parse(readFileSync(new URL(name, privateDir), 'utf8')) as unknown;
  const opts = { currencyAliases: { LPS: 'HNL' } };
  it('parse every response example', () => {
    const files = readdirSync(privateDir);
    const has = (f: string) => files.includes(f);
    if (has('camt052-response.json'))
      expect(parseAccountReport(unwrap(load('camt052-response.json'))?.Document, {}, opts).balances[0]?.type).toBe('INTERIM_AVAILABLE');
    if (has('camt053-response.json'))
      expect(parseStatement(unwrap(load('camt053-response.json'))?.Document, {}, opts).account.currency).toBe('HNL');
    if (has('pain002-response-l2.json'))
      expect(parsePaymentStatusReport(unwrap(load('pain002-response-l2.json'))?.Document, {}, opts).state).toBe('PARTIAL');
    if (has('admi004-response.json')) expect(parseSystemEvent(unwrap(load('admi004-response.json'))?.Document).eventCode).toBe('RCVD');
    if (has('admi002-response.json'))
      expect(parseMessageReject(unwrap(load('admi002-response.json'))?.Document)?.code).toBe('DUPLICATE_MESSAGE_ID');
    for (const mt of ['mt940-response.json', 'mt942-response.json'].filter(has)) {
      expect(mtToStatement(decodeMtFile((load(mt) as { File: string }).File)).entries.length).toBeGreaterThan(0);
    }
  });
});
