// Connector conformance suite (SPEC clause 12.1). Framework-agnostic: `runConformance` returns
// results; adapters for Vitest/node:test just iterate `conformanceCases`.
import assert from 'node:assert/strict';
import type { BankConnector, BankSession, SimulationEngine } from '@iso20022-bank-kit/core';
import { BankError, ConnectionError, createBankClient, UnsupportedError, ValidationError } from '@iso20022-bank-kit/core';
import type { AccountRef, StatementFormat } from '@iso20022-bank-kit/iso20022';
import { isIso4217, isValidBic } from '@iso20022-bank-kit/iso20022';
import { sampleBatch, simulationFor, uniqueMessageId, yesterday } from '@iso20022-bank-kit/simulator';

export interface ConformanceOptions {
  connector: BankConnector;
  /** Country to test in; defaults to the first declared country. */
  country?: string;
  /** Debtor account; defaults to number 999888666 (give an IBAN for IBAN-only countries). */
  account?: AccountRef;
  /** Creditor account for generated transfers; defaults to `account`. */
  creditorAccount?: AccountRef;
}

export interface Harness {
  connector: BankConnector;
  country: string;
  currency: string;
  account: AccountRef;
  session: BankSession;
  /** Calls the connector made to submitPayment on the engine. */
  submissions: () => number;
  batch: (overrides?: Parameters<typeof sampleBatch>[2]) => ReturnType<typeof sampleBatch>;
}

export interface ConformanceCase {
  /** Requirement identifiers this case verifies. */
  requirements: string[];
  title: string;
  run(h: Harness): Promise<void>;
}

function countingEngine(engine: SimulationEngine) {
  let n = 0;
  const wrapped: SimulationEngine = {
    ...engine,
    submitPayment: (b) => {
      n++;
      return engine.submitPayment(b);
    },
  };
  return { engine: wrapped, count: () => n };
}

export function createHarness(o: ConformanceOptions): Harness {
  const profile = o.country ? o.connector.countries.find((c) => c.code === o.country) : o.connector.countries[0];
  if (!profile) throw new Error(`${o.connector.name} does not declare country ${o.country}`);
  const account = o.account ?? { number: '999888666' };
  if (profile.requiresIban && !account.iban) throw new Error(`${profile.code} requires IBAN accounts: pass options.account`);
  const creditorAccount = o.creditorAccount ?? account;
  const { engine, count } = countingEngine(simulationFor([o.connector]));
  const client = createBankClient({ connectors: [o.connector], backend: 'simulated', simulation: engine });
  const routes = o.connector.capabilities.routes;
  return {
    connector: o.connector,
    country: profile.code,
    currency: profile.localCurrency,
    account,
    session: client.session(o.connector.id),
    submissions: count,
    batch: (overrides = {}) => {
      const b = sampleBatch(profile.code, profile.localCurrency, { debtorAccount: account, ...overrides });
      const transfers = (overrides.transfers ?? b.transfers)
        .filter((t) => routes.includes(t.route))
        .map((t) => (t.route === 'CROSS_BORDER' ? t : { ...t, creditorAccount }));
      return { ...b, transfers };
    },
  };
}

const DECIMAL = /^\d+(\.\d+)?$/;

export const conformanceCases: ConformanceCase[] = [
  {
    requirements: ['IBK-PLG-001'],
    title: 'declares countries, capabilities and connection fields',
    async run({ connector }) {
      assert.ok(connector.countries.length > 0, 'at least one country');
      for (const c of connector.countries) {
        assert.match(c.code, /^[A-Z]{2}$/, `${c.code} is ISO 3166 alpha-2`);
        assert.ok(isValidBic(c.bankBic), `${c.code} bankBic ${c.bankBic} is a valid BIC`);
        assert.ok(isIso4217(c.localCurrency), `${c.code} localCurrency is ISO 4217`);
      }
      assert.ok(Array.isArray(connector.capabilities.statementFormats));
      assert.ok(connector.capabilities.routes.length > 0, 'at least one transfer route');
      assert.ok(Array.isArray(connector.connectionFields));
    },
  },
  {
    requirements: ['IBK-PLG-002'],
    title: 'undeclared country fails as UNSUPPORTED without contacting the bank',
    async run({ session, account, submissions, batch }) {
      await assert.rejects(session.getBalance({ country: 'ZZ', account }), UnsupportedError);
      await assert.rejects(
        session.initiatePayment({ ...batch(), country: 'ZZ' }),
        (e) => e instanceof ValidationError || e instanceof UnsupportedError,
      );
      assert.equal(submissions(), 0);
    },
  },
  {
    requirements: ['IBK-SIM-001', 'IBK-MOD-001', 'IBK-MOD-003'],
    title: 'balance is deterministic, decimal-string and ISO 4217',
    async run(h) {
      if (!h.connector.capabilities.balance) return;
      const a = await h.session.getBalance({ country: h.country, account: h.account });
      const b = await createHarness({ connector: h.connector, country: h.country, account: h.account }).session.getBalance({
        country: h.country,
        account: h.account,
      });
      assert.equal(a.balances[0]?.amount, b.balances[0]?.amount, 'same figure on a fresh engine');
      for (const bal of a.balances) {
        assert.match(String(bal.amount), DECIMAL);
        assert.equal(typeof bal.amount, 'string');
        assert.ok(bal.currency && isIso4217(bal.currency), `currency ${bal.currency} is ISO 4217`);
      }
    },
  },
  {
    requirements: ['IBK-STM-001', 'IBK-SIM-001', 'IBK-MOD-002'],
    title: 'every declared statement format yields the same entries',
    async run(h) {
      const formats = h.connector.capabilities.statementFormats;
      const norm = (s: Awaited<ReturnType<BankSession['getStatement']>>) =>
        s.entries.map((e) => ({
          reference: e.reference,
          amount: Number(e.amount).toFixed(2),
          creditDebit: e.creditDebit,
          transactionType: e.transactionType,
        }));
      const results: Record<string, ReturnType<typeof norm>> = {};
      for (const format of formats as StatementFormat[]) {
        const s = await h.session.getStatement({ country: h.country, account: h.account, format, fromDate: yesterday() });
        assert.equal(s.format, format);
        for (const e of s.entries) {
          assert.equal(typeof e.amount, 'string');
          assert.ok(e.transactionType === 'UNKNOWN' || e.transactionTypeCode, 'raw transaction type kept when mapped');
        }
        results[format] = norm(s);
      }
      const [first, ...rest] = Object.values(results);
      assert.equal(first?.length, 5, 'five seed entries yesterday');
      for (const r of rest) assert.deepEqual(r, first);
    },
  },
  {
    requirements: ['IBK-PAY-002', 'IBK-PAY-003', 'IBK-SIM-008', 'IBK-STS-001', 'IBK-SIM-004'],
    title: 'submit, track to completion, and reject a duplicate',
    async run(h) {
      const b = h.batch();
      const sent = await h.session.initiatePayment(b);
      assert.equal(sent.result, 'SUBMITTED');
      const first = await h.session.getPaymentStatus({ country: h.country, messageId: b.messageId });
      assert.equal(first.state, 'IN_PROGRESS');
      const second = await h.session.getPaymentStatus({ country: h.country, messageId: b.messageId });
      assert.equal(second.state, 'COMPLETED');
      const again = await h.session.initiatePayment(b);
      assert.equal(again.result, 'REJECTED');
      assert.ok(again.result === 'REJECTED' && again.duplicate, 'duplicate=true');
      assert.ok(again.result === 'REJECTED' && again.bankCode === '1010', 'reason code 1010');
    },
  },
  {
    requirements: ['IBK-PAY-001', 'IBK-PAY-002', 'IBK-SIM-002'],
    title: 'HTTP 500 after booking is OUTCOME_UNKNOWN, sent once, and the batch exists',
    async run(h) {
      const b = h.batch({ messageId: uniqueMessageId('MOCK-500') });
      const r = await h.session.initiatePayment(b);
      assert.equal(r.result, 'OUTCOME_UNKNOWN');
      assert.ok(
        r.result === 'OUTCOME_UNKNOWN' &&
          /status/i.test(r.guidance) &&
          !/new messageId/i.test(r.guidance.replace(/never resend with a different messageId/i, '')),
      );
      assert.equal(h.submissions(), 1, 'transmitted exactly once');
      const s = await h.session.getPaymentStatus({ country: h.country, messageId: b.messageId });
      assert.equal(s.messageId, b.messageId);
    },
  },
  {
    requirements: ['IBK-PAY-001', 'IBK-PAY-002', 'IBK-SIM-007'],
    title: 'timeout after booking is OUTCOME_UNKNOWN(TIMEOUT), sent once',
    async run(h) {
      const r = await h.session.initiatePayment(h.batch({ messageId: uniqueMessageId('MOCK-TIMEOUT') }));
      assert.equal(r.result, 'OUTCOME_UNKNOWN');
      assert.ok(r.result === 'OUTCOME_UNKNOWN' && r.category === 'TIMEOUT');
      assert.equal(h.submissions(), 1);
    },
  },
  {
    requirements: ['IBK-PAY-002', 'IBK-SIM-003'],
    title: 'HTTP 503 is OUTCOME_UNKNOWN and nothing is booked',
    async run(h) {
      const b = h.batch({ messageId: uniqueMessageId('MOCK-503') });
      const r = await h.session.initiatePayment(b);
      assert.equal(r.result, 'OUTCOME_UNKNOWN');
      await assert.rejects(h.session.getPaymentStatus({ country: h.country, messageId: b.messageId }), BankError);
    },
  },
  {
    requirements: ['IBK-STS-002', 'IBK-SIM-005'],
    title: 'one rejected transfer makes the batch PARTIAL',
    async run(h) {
      const base = h.batch();
      const [t0, ...others] = base.transfers;
      assert.ok(t0 && others.length > 0, 'needs at least two transfers');
      const b = { ...base, transfers: [{ ...t0, creditor: { ...t0.creditor, name: 'REJECT me' } }, ...others] };
      await h.session.initiatePayment(b);
      await h.session.getPaymentStatus({ country: h.country, messageId: b.messageId });
      const s = await h.session.getPaymentStatus({ country: h.country, messageId: b.messageId });
      assert.equal(s.state, 'PARTIAL');
      const states = s.paymentInfos.flatMap((p) => p.transactions.map((t) => t.state));
      assert.equal(states[0], 'FAILED');
      assert.ok(states.slice(1).every((x) => x === 'COMPLETED'));
    },
  },
  {
    requirements: ['IBK-SIM-006'],
    title: 'account 000000000 is rejected with HTTP 422',
    async run(h) {
      if (h.connector.countries.find((c) => c.code === h.country)?.requiresIban) return;
      await assert.rejects(
        h.session.getBalance({ country: h.country, account: { number: '000000000' } }),
        (e) => e instanceof BankError && e.details.httpStatus === 422,
      );
    },
  },
  {
    requirements: ['IBK-PAY-005'],
    title: 'an invalid batch reports every problem and transmits nothing',
    async run(h) {
      const b = h.batch();
      const [t0] = b.transfers;
      assert.ok(t0);
      const bad = {
        ...b,
        debtorName: 'x'.repeat(141),
        transfers: [
          { ...t0, amount: '0' },
          { ...t0, amount: '1.234' },
        ],
      };
      await assert.rejects(h.session.initiatePayment(bad), (e) => e instanceof ValidationError && e.problems.length >= 3);
      assert.equal(h.submissions(), 0);
    },
  },
  {
    requirements: ['IBK-SEC-002', 'IBK-SEC-003'],
    title: 'live endpoints must be allowlisted https, and errors never echo secrets',
    async run({ connector }) {
      const secret = connector.connectionFields.find((f) => f.secret);
      const endpoint = connector.connectionFields.find((f) => f.key === 'endpoint');
      if (!endpoint) return;
      const conn: Record<string, string> = { endpoint: 'http://attacker.example/api', tokenUrl: 'http://attacker.example/token' };
      for (const f of connector.connectionFields) if (f.required) conn[f.key] = f.secret ? 'S3CRET-VALUE-123' : (f.values?.[0] ?? 'X');
      const client = createBankClient({ connectors: [connector], backend: 'live', allowedHosts: ['*.bank.example'] });
      try {
        client.session(connector.id, conn);
        assert.fail('expected a ConnectionError');
      } catch (e) {
        assert.ok(e instanceof ConnectionError, `got ${(e as Error).name}`);
        if (secret) assert.ok(!(e as Error).message.includes('S3CRET-VALUE-123'), 'secret not echoed');
      }
    },
  },
];

export interface ConformanceResult {
  title: string;
  requirements: string[];
  ok: boolean;
  error?: string;
}

/** Runs every case on a fresh harness. */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const c of conformanceCases) {
    try {
      await c.run(createHarness(options));
      results.push({ title: c.title, requirements: c.requirements, ok: true });
    } catch (e) {
      results.push({ title: c.title, requirements: c.requirements, ok: false, error: (e as Error).message });
    }
  }
  return results;
}
