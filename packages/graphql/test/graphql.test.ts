import { bacConnector } from '@iso20022-bank-kit/connector-bac';
import { createBankClient } from '@iso20022-bank-kit/core';
import { buildSdl, createGraphQLHandler } from '@iso20022-bank-kit/graphql';
import { createSimulatedConnector, simulationFor, today, yesterday } from '@iso20022-bank-kit/simulator';
import { buildSchema, isEnumType } from 'graphql';
import { describe, expect, it } from 'vitest';

const connectors = [bacConnector, createSimulatedConnector()];
const handler = (backend: 'simulated' | 'live' = 'simulated') =>
  createGraphQLHandler({
    client: createBankClient({
      connectors,
      backend,
      ...(backend === 'simulated' ? { simulation: simulationFor(connectors) } : {}),
      allowedHosts: ['*.baccredomatic.com'],
    }),
  });

function client(backend: 'simulated' | 'live' = 'simulated') {
  const yoga = handler(backend);
  return async (query: string, variables?: Record<string, unknown>) => {
    const res = await yoga.fetch('http://test/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    return (await res.json()) as { data?: Record<string, any>; errors?: { message: string; extensions: Record<string, any> }[] };
  };
}

const PAY = `mutation($input: PaymentBatchInput!) { bac { initiatePayment(input: $input) {
  __typename ... on PaymentSubmitted { messageId } ... on PaymentRejected { duplicate bankCode } ... on PaymentOutcomeUnknown { category httpStatus guidance } } } }`;
const input = (messageId: string) => ({
  messageId,
  country: 'HN',
  debtorName: 'Example',
  debtorAccount: { number: '999888666' },
  requestedExecutionDate: today(),
  transfers: [
    {
      endToEndId: `${messageId}-1`,
      route: 'INTRABANK',
      amount: '10.00',
      currency: 'HNL',
      creditor: { name: 'A' },
      creditorAccount: { number: '1' },
    },
  ],
});

describe('generated schema', () => {
  it('builds valid SDL with a field and connection input per connector', () => {
    const sdl = buildSdl(connectors);
    const schema = buildSchema(sdl);
    expect(Object.keys(schema.getQueryType()?.getFields() ?? {})).toEqual(['serviceInfo', 'connectors', 'bac', 'sim']);
    expect(schema.getType('BacConnectionInput')).toBeTruthy();
    expect(schema.getType('BacEnvironment')).toBeTruthy();
    const country = schema.getType('Country');
    if (!isEnumType(country)) throw new Error('Country is not an enum');
    expect(country.getValues().map((v) => v.name)).toEqual(['CR', 'DE', 'GB', 'GT', 'HN', 'MX', 'NI', 'PA', 'SV', 'US']);
  });
  it('introspection exposes the enums', async () => {
    const r = await client()('{ __schema { types { name kind } } }');
    const enums = r.data?.__schema.types
      .filter((t: { kind: string; name: string }) => t.kind === 'ENUM' && !t.name.startsWith('__'))
      .map((t: { name: string }) => t.name);
    expect(enums).toEqual(
      expect.arrayContaining([
        'Country',
        'Currency',
        'PaymentStatusCode',
        'TransferRoute',
        'BalanceType',
        'TransactionType',
        'BacEnvironment',
        'BacTokenAuth',
      ]),
    );
  });
});

describe('operations', () => {
  it('IBK-SEC-004: serviceInfo exposes the backend', async () => {
    expect((await client()('{ serviceInfo { backend } }')).data).toEqual({ serviceInfo: { backend: 'SIMULATED' } });
  });
  it('balance, statement and currencyCode', async () => {
    const q = client();
    const r = await q(
      `{ bac { balance(country: HN, account: { number: "999888666" }) { balances { type amount currency currencyCode } } } }`,
    );
    expect(r.data?.bac.balance.balances[0]).toMatchObject({ type: 'INTERIM_AVAILABLE', currency: 'HNL', currencyCode: 'HNL' });
    const s = await q(
      `query($d: Date!) { bac { statement(country: HN, account: { number: "999888666" }, format: MT940, fromDate: $d) { format raw closingBalance { amount } entries(creditDebit: CREDIT) { amount } } } }`,
      { d: yesterday() },
    );
    expect(s.data?.bac.statement.format).toBe('MT940');
    expect(s.data?.bac.statement.raw).toMatch(/^\{1:F01BMILHNTE/);
    expect(s.data?.bac.statement.entries).toHaveLength(3);
  });
  it('payment lifecycle and result union', async () => {
    const q = client();
    expect((await q(PAY, { input: input('G-1') })).data?.bac.initiatePayment.__typename).toBe('PaymentSubmitted');
    expect((await q(PAY, { input: input('G-1') })).data?.bac.initiatePayment).toMatchObject({
      __typename: 'PaymentRejected',
      duplicate: true,
      bankCode: '1010',
    });
    expect((await q(PAY, { input: input('MOCK-500-G') })).data?.bac.initiatePayment).toMatchObject({
      __typename: 'PaymentOutcomeUnknown',
      httpStatus: 500,
    });
    const st = await q(
      `{ bac { paymentStatus(country: HN, messageId: "G-1") { state paymentInfos { transactions(state: IN_PROGRESS) { endToEndId } } } } }`,
    );
    expect(st.data?.bac.paymentStatus.state).toBe('IN_PROGRESS');
  });
  it('errors carry codes: validation, unsupported, bank rejection', async () => {
    const q = client();
    const v = await q(PAY, { input: { ...input('G-2'), transfers: [] } });
    expect(v.errors?.[0]?.extensions).toMatchObject({ code: 'BAD_USER_INPUT', problems: ['transfers must contain at least one transfer'] });
    const u = await q(`{ sim { statement(country: US, account: { number: "1" }, format: MT940, fromDate: "2026-01-01") { format } } }`);
    expect(u.errors?.[0]?.extensions.code).toBe('UNSUPPORTED');
    const b = await q(`{ bac { balance(country: HN, account: { number: "000000000" }) { reportId } } }`);
    expect(b.errors?.[0]?.extensions).toMatchObject({ code: 'VALIDATION_FAILED', httpStatus: 422 });
  });
  it('schema enforces enums and @oneOf', async () => {
    const q = client();
    expect((await q(`{ bac { balance(country: XX, account: { number: "1" }) { reportId } } }`)).errors?.[0]?.message).toMatch(/Country/);
    expect((await q(`{ bac { balance(country: HN, account: { number: "1", iban: "x" }) { reportId } } }`)).errors?.[0]?.message).toMatch(
      /exactly one/i,
    );
  });
  it('live mode: connection required; secrets never echoed (IBK-SEC-003)', async () => {
    const q = client('live');
    const none = await q(`{ bac { balance(country: HN, account: { number: "1" }) { reportId } } }`);
    expect(none.errors?.[0]?.extensions.code).toBe('BAD_CONNECTION');
    const evil = await q(
      `query($c: BacConnectionInput) { bac(connection: $c) { balance(country: HN, account: { number: "1" }) { reportId } } }`,
      {
        c: { clientId: 'i', clientSecret: 'TOPSECRET-42', clientBic: 'C', ownerBic: 'O', endpoint: 'https://evil.example' },
      },
    );
    expect(evil.errors?.[0]?.message).toMatch(/allowed host/);
    expect(JSON.stringify(evil)).not.toContain('TOPSECRET-42');
  });
});
