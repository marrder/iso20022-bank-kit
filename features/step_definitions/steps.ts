import assert from 'node:assert/strict';
import type { DataTable } from '@cucumber/cucumber';
import { Given, setWorldConstructor, Then, When, World } from '@cucumber/cucumber';
import { bacConnector } from '@iso20022-bank-kit/connector-bac';
import {
  type BankConnector,
  BankError,
  type BankSession,
  createBankClient,
  type SimulationEngine,
  UnsupportedError,
  ValidationError,
} from '@iso20022-bank-kit/core';
import type { AccountRef, BalanceReport, PaymentBatch, PaymentOutcome, PaymentStatusReport, Statement } from '@iso20022-bank-kit/iso20022';
import { createBankMcpServer } from '@iso20022-bank-kit/mcp';
import { createSimulatedConnector, sampleBatch, simulationFor, uniqueMessageId, yesterday } from '@iso20022-bank-kit/simulator';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

const CONNECTORS: Record<string, () => BankConnector> = { bac: () => bacConnector, sim: () => createSimulatedConnector() };

class BankWorld extends World {
  connector!: BankConnector;
  session!: BankSession;
  country = '';
  account: AccountRef = {};
  submissions = 0;
  batch?: PaymentBatch;
  outcome?: PaymentOutcome;
  statuses: PaymentStatusReport[] = [];
  statements: Statement[] = [];
  balances: BalanceReport[] = [];
  error?: unknown;
  liveClient?: ReturnType<typeof createBankClient>;
  mcp?: Client;

  open(bank: string, country: string, account: string) {
    const make = CONNECTORS[bank];
    assert.ok(make, `unknown bank ${bank}`);
    this.connector = make();
    this.country = country;
    this.account = /^[A-Z]{2}\d{2}/.test(account) ? { iban: account } : { number: account };
    const engine = simulationFor([this.connector]);
    const counted: SimulationEngine = {
      ...engine,
      submitPayment: (b) => {
        this.submissions++;
        return engine.submitPayment(b);
      },
    };
    this.session = createBankClient({ connectors: [this.connector], backend: 'simulated', simulation: counted }).session(this.connector.id);
  }

  makeBatch(messageId = uniqueMessageId('BDD')): PaymentBatch {
    const profile = this.connector.countries.find((c) => c.code === this.country);
    assert.ok(profile);
    const b = sampleBatch(this.country, profile.localCurrency, { messageId, debtorAccount: this.account });
    return { ...b, transfers: b.transfers.map((t) => (t.route === 'CROSS_BORDER' ? t : { ...t, creditorAccount: this.account })) };
  }

  async attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      this.error = undefined;
      return await fn();
    } catch (e) {
      this.error = e;
      return undefined;
    }
  }
}
setWorldConstructor(BankWorld);

Given(
  'the simulated {word} bank in {word} with account {word}',
  function (this: BankWorld, bank: string, country: string, account: string) {
    this.open(bank, country, account);
  },
);

Given('the {word} connector', function (this: BankWorld, bank: string) {
  const make = CONNECTORS[bank];
  assert.ok(make);
  this.connector = make();
});

When('I submit a valid payment batch', async function (this: BankWorld) {
  this.batch = this.makeBatch();
  this.outcome = await this.session.initiatePayment(this.batch);
});

When('I submit the same batch again', async function (this: BankWorld) {
  assert.ok(this.batch);
  this.outcome = await this.session.initiatePayment(this.batch);
});

When('I submit a valid payment batch with messageId starting {string}', async function (this: BankWorld, prefix: string) {
  this.batch = this.makeBatch(uniqueMessageId(prefix));
  this.outcome = await this.session.initiatePayment(this.batch);
});

When('I submit a batch whose creditor accounts are not IBANs and whose amounts are zero', async function (this: BankWorld) {
  const b = this.makeBatch();
  const [t0] = b.transfers;
  assert.ok(t0);
  this.batch = { ...b, transfers: [{ ...t0, amount: '0', creditorAccount: { number: '123' } }] };
  await this.attempt(() => this.session.initiatePayment(this.batch as PaymentBatch));
});

When('I submit a payment batch whose first creditor is {string}', async function (this: BankWorld, name: string) {
  const b = this.makeBatch();
  const [t0, ...rest] = b.transfers;
  assert.ok(t0);
  this.batch = { ...b, transfers: [{ ...t0, creditor: { ...t0.creditor, name } }, ...rest] };
  this.outcome = await this.session.initiatePayment(this.batch);
});

When('I check the payment status twice', async function (this: BankWorld) {
  assert.ok(this.batch);
  for (let i = 0; i < 2; i++)
    this.statuses.push(await this.session.getPaymentStatus({ country: this.country, messageId: this.batch.messageId }));
});

Then(/^the outcome is (SUBMITTED|OUTCOME_UNKNOWN)$/, function (this: BankWorld, result: string) {
  assert.equal(this.outcome?.result, result);
});

Then('the outcome is OUTCOME_UNKNOWN with category {string}', function (this: BankWorld, category: string) {
  assert.ok(this.outcome?.result === 'OUTCOME_UNKNOWN');
  assert.equal(this.outcome.category, category);
});

Then('the outcome is REJECTED as a duplicate with bank code {string}', function (this: BankWorld, code: string) {
  assert.ok(this.outcome?.result === 'REJECTED');
  assert.equal(this.outcome.duplicate, true);
  assert.equal(this.outcome.bankCode, code);
});

Then('the guidance says to check the payment status', function (this: BankWorld) {
  assert.ok(this.outcome?.result === 'OUTCOME_UNKNOWN');
  assert.match(this.outcome.guidance, /payment status/);
  assert.match(this.outcome.guidance, /Never resend with a different messageId/);
});

Then('the batch was transmitted exactly once', function (this: BankWorld) {
  assert.equal(this.submissions, 1);
});

Then('nothing was transmitted', function (this: BankWorld) {
  assert.equal(this.submissions, 0);
});

Then('the payment status lookup finds the batch', async function (this: BankWorld) {
  assert.ok(this.batch);
  const s = await this.session.getPaymentStatus({ country: this.country, messageId: this.batch.messageId });
  assert.equal(s.messageId, this.batch.messageId);
});

Then('the payment status lookup fails', async function (this: BankWorld) {
  assert.ok(this.batch);
  const batch = this.batch;
  await assert.rejects(this.session.getPaymentStatus({ country: this.country, messageId: batch.messageId }), BankError);
});

Then(/^the (first|next) status check says (\w+)$/, async function (this: BankWorld, _which: string, state: string) {
  assert.ok(this.batch);
  const s = await this.session.getPaymentStatus({ country: this.country, messageId: this.batch.messageId });
  assert.equal(s.state, state);
});

Then('the request is refused with these problems:', function (this: BankWorld, table: DataTable) {
  assert.ok(this.error instanceof ValidationError, `expected a ValidationError, got ${String(this.error)}`);
  for (const [problem] of table.raw())
    assert.ok(this.error.problems.includes(problem ?? ''), `missing: ${problem}\nactual: ${this.error.problems.join('\n')}`);
});

When("I request yesterday's statement in every format the bank supports", async function (this: BankWorld) {
  for (const format of this.connector.capabilities.statementFormats) {
    this.statements.push(await this.session.getStatement({ country: this.country, account: this.account, format, fromDate: yesterday() }));
  }
});

Then('every format lists the same {int} entries', function (this: BankWorld, n: number) {
  const norm = (s: Statement) => s.entries.map((e) => [e.reference, Number(e.amount).toFixed(2), e.creditDebit, e.transactionType]);
  const [first, ...rest] = this.statements.map(norm);
  assert.equal(first?.length, n);
  for (const r of rest) assert.deepEqual(r, first);
});

When('I request the balance twice on fresh simulators', async function (this: BankWorld) {
  for (let i = 0; i < 2; i++) {
    this.open(this.connector.id, this.country, this.account.iban ?? this.account.number ?? '');
    this.balances.push(await this.session.getBalance({ country: this.country, account: this.account }));
  }
});

Then('both balances are {string} {string}', function (this: BankWorld, amount: string, currency: string) {
  for (const b of this.balances) {
    assert.equal(b.balances[0]?.amount, amount);
    assert.equal(typeof b.balances[0]?.amount, 'string');
    assert.equal(b.balances[0]?.currency, currency);
  }
});

Then('the batch state is PARTIAL', function (this: BankWorld) {
  assert.equal(this.statuses.at(-1)?.state, 'PARTIAL');
});

Then('the transfer states are FAILED, then COMPLETED for the rest', function (this: BankWorld) {
  const states = this.statuses.at(-1)?.paymentInfos.flatMap((p) => p.transactions.map((t) => t.state)) ?? [];
  assert.equal(states[0], 'FAILED');
  assert.ok(
    states.slice(1).every((s) => s === 'COMPLETED'),
    states.join(','),
  );
});

const list = (s: string) => s.split(',').map((x) => x.trim());

Then(/^it declares countries (.+)$/, function (this: BankWorld, codes: string) {
  assert.deepEqual(
    this.connector.countries.map((c) => c.code),
    list(codes),
  );
});

Then(/^it declares statement formats (.+)$/, function (this: BankWorld, formats: string) {
  assert.deepEqual([...this.connector.capabilities.statementFormats], list(formats));
});

When('I request an MT940 statement', async function (this: BankWorld) {
  await this.attempt(() =>
    this.session.getStatement({ country: this.country, account: this.account, format: 'MT940', fromDate: yesterday() }),
  );
});

When('I request the balance', async function (this: BankWorld) {
  await this.attempt(() => this.session.getBalance({ country: this.country, account: this.account }));
});

Then('the request fails as UNSUPPORTED', function (this: BankWorld) {
  assert.ok(this.error instanceof UnsupportedError);
});

Then('the bank rejects it with HTTP {int}', function (this: BankWorld, status: number) {
  assert.ok(this.error instanceof BankError);
  assert.equal(this.error.details.httpStatus, status);
});

Given('a live bac client allowing only {string}', function (this: BankWorld, host: string) {
  this.liveClient = createBankClient({ connectors: [bacConnector], backend: 'live', allowedHosts: [host] });
});

When('I open a session with endpoint {string} and client secret {string}', function (this: BankWorld, endpoint: string, secret: string) {
  try {
    this.liveClient?.session('bac', { endpoint, clientId: 'id', clientSecret: secret, clientBic: 'C', ownerBic: 'O' });
  } catch (e) {
    this.error = e;
  }
});

Then('the session is refused because the endpoint is not allowed', function (this: BankWorld) {
  assert.match((this.error as Error)?.message ?? '', /allowed host/);
});

Then('the error does not contain {string}', function (this: BankWorld, secret: string) {
  assert.ok(!JSON.stringify({ message: (this.error as Error).message, ...(this.error as object) }).includes(secret));
});

Given('an MCP server for the bac and sim connectors', async function (this: BankWorld) {
  const connectors = [bacConnector, createSimulatedConnector()];
  const client = createBankClient({ connectors, backend: 'simulated', simulation: simulationFor(connectors) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createBankMcpServer({ client, connections: () => null }).connect(b);
  this.mcp = new Client({ name: 'bdd', version: '1.0.0' });
  await this.mcp.connect(a);
});

Then('no tool argument looks like a credential', async function (this: BankWorld) {
  const { tools } = (await this.mcp?.listTools()) ?? { tools: [] };
  assert.ok(tools.length > 0);
  for (const t of tools) assert.doesNotMatch(JSON.stringify(t.inputSchema), /secret|client_?id|password|token|api_?key/i, t.name);
});

Then('the service info reports backend SIMULATED', async function (this: BankWorld) {
  const r = await this.mcp?.callTool({ name: 'bank_get_service_info', arguments: {} });
  assert.equal((r?.structuredContent as { backend?: string } | undefined)?.backend, 'SIMULATED');
});
