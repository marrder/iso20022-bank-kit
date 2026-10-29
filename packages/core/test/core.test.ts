import { createServer } from 'node:http';
import {
  assertAllowedUrl,
  type BankConnector,
  BankError,
  ConnectionError,
  classifyThrown,
  connectionFromEnv,
  connectionFromHeaders,
  createBankClient,
  createClientFromEnv,
  createOAuthJsonClient,
  defineConnector,
  envName,
  headerName,
  redactConnection,
  resolveConnection,
  TransportError,
  UnsupportedError,
  ValidationError,
  validatePaymentBatch,
} from '@iso20022-bank-kit/core';
import { createSimulatedConnector, sampleBatch, simulationFor } from '@iso20022-bank-kit/simulator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sim = createSimulatedConnector();
const withFields: BankConnector = {
  ...sim,
  id: 'acme',
  name: 'Acme',
  connectionFields: [
    { key: 'clientId', description: 'id', required: true },
    { key: 'clientSecret', description: 'secret', required: true, secret: true },
    { key: 'environment', description: 'env', values: ['SANDBOX', 'PRODUCTION'], default: 'SANDBOX' },
  ],
  // A live connector that never actually calls out in these tests.
  open: () => ({
    getBalance: () => Promise.reject(new Error('not used')),
    getStatement: () => Promise.reject(new Error('not used')),
    getPaymentStatus: () => Promise.reject(new Error('not used')),
    initiatePayment: () => Promise.reject(new Error('not used')),
  }),
};

describe('connector contract', () => {
  it('rejects non lower-case ids', () => {
    expect(() => defineConnector({ ...sim, id: 'Bad-Id' })).toThrow(/lower-case/);
  });
  it('derives env and header names from fields', () => {
    expect(envName(withFields, { key: 'clientSecret' })).toBe('ACME_CLIENT_SECRET');
    expect(headerName(withFields, { key: 'clientSecret' })).toBe('x-acme-client-secret');
    expect(connectionFromEnv(withFields, { ACME_CLIENT_ID: 'i', ACME_CLIENT_SECRET: 's' })).toEqual({ clientId: 'i', clientSecret: 's' });
    expect(connectionFromHeaders(withFields, new Headers({ 'X-Acme-Client-Id': 'h' }))).toEqual({ clientId: 'h' });
    expect(connectionFromEnv(withFields, {})).toBeNull();
  });
  it('resolves defaults, enforces required fields and enum values', () => {
    expect(resolveConnection(withFields, { clientId: 'i', clientSecret: 's' }).environment).toBe('SANDBOX');
    expect(() => resolveConnection(withFields, { clientId: 'i' })).toThrow(/missing clientSecret/);
    expect(() => resolveConnection(withFields, { clientId: 'i', clientSecret: 's', environment: 'DEV' })).toThrow(
      /one of SANDBOX, PRODUCTION/,
    );
  });
  it('IBK-SEC-003: redacts secret fields', () => {
    expect(redactConnection(withFields, { clientId: 'i', clientSecret: 'TOPSECRET' })).toEqual({ clientId: 'i', clientSecret: '***' });
  });
});

describe('IBK-SEC-002: endpoint allowlist', () => {
  it('requires https on an allowed host', () => {
    expect(() => assertAllowedUrl('https://api.bank.example/x', ['*.bank.example'])).not.toThrow();
    expect(() => assertAllowedUrl('https://bank.example/x', ['bank.example'])).not.toThrow();
    expect(() => assertAllowedUrl('http://api.bank.example/x', ['*.bank.example'])).toThrow(ConnectionError);
    expect(() => assertAllowedUrl('https://evil.example/x', ['*.bank.example'])).toThrow(ConnectionError);
    expect(() => assertAllowedUrl('https://bank.example.evil.com/x', ['*.bank.example'])).toThrow(ConnectionError);
    expect(() => assertAllowedUrl('not a url', ['*'])).toThrow(/valid URL/);
  });
});

describe('IBK-PAY-005: generic validation', () => {
  it('collects every problem', () => {
    const b = sampleBatch('US', 'USD');
    const bad = {
      ...b,
      messageId: 'X'.repeat(36),
      requestedExecutionDate: '2026-02-30',
      debtorAccount: { number: '1', iban: 'GB52SIMB00000012345678' },
      transfers: [
        { ...b.transfers[1]!, creditorBankCode: undefined, amount: '0', currency: 'XYZ' },
        { ...b.transfers[2]!, endToEndId: b.transfers[1]!.endToEndId, creditorBankBic: 'bad', creditor: { name: 'x' } },
      ],
    };
    const problems = validatePaymentBatch(bad, sim);
    for (const p of [
      /messageId must be at most 35/,
      /requestedExecutionDate/,
      /exactly one of number or iban/,
      /creditorBankCode is required/,
      /positive decimal/,
      /ISO 4217/,
      /repeated/,
      /not a valid BIC/,
      /address is required/,
    ]) {
      expect(
        problems.some((x) => p.test(x)),
        String(p),
      ).toBe(true);
    }
  });
  it('checks IBAN-only countries and IBAN check digits per connector policy', () => {
    const gb = sampleBatch('GB', 'GBP', { debtorAccount: { iban: 'GB53SIMB00000012345678' } });
    expect(validatePaymentBatch(gb, sim).some((p) => /check digits/.test(p))).toBe(true);
    const lenient = { ...sim, capabilities: { ...sim.capabilities, ibanCheckDigits: 'format-only' as const } };
    expect(validatePaymentBatch(gb, lenient).some((p) => /debtorAccount.iban/.test(p))).toBe(false);
    expect(validatePaymentBatch(gb, sim).some((p) => /GB accounts must use iban/.test(p))).toBe(true);
  });
});

describe('client guard', () => {
  const client = createBankClient({ connectors: [sim], backend: 'simulated', simulation: simulationFor([sim]) });
  const s = client.session('sim');
  it('IBK-PLG-002: unsupported country and format fail before reaching the bank', async () => {
    await expect(s.getBalance({ country: 'ZZ', account: { number: '1' } })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(s.getStatement({ country: 'US', account: { number: '1' }, format: 'MT940', fromDate: '2026-01-01' })).rejects.toThrow(
      /does not support MT940/,
    );
    expect(() => client.session('nope')).toThrow(/Unknown connector/);
  });
  it('validates statement requests', async () => {
    await expect(
      s.getStatement({ country: 'US', account: { number: '1' }, format: 'CAMT053', fromDate: '2026-01-02', toDate: '2026-01-01' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
  it('IBK-PAY-005: invalid batches never reach the session', async () => {
    let called = false;
    const spy: BankConnector = {
      ...sim,
      open: (c, ctx) => ({
        ...sim.open(c, ctx),
        initiatePayment: async () => {
          called = true;
          throw new Error('sent');
        },
      }),
    };
    const c = createBankClient({ connectors: [spy], backend: 'simulated', simulation: simulationFor([spy]) });
    await expect(c.session('sim').initiatePayment({ ...sampleBatch('US', 'USD'), transfers: [] })).rejects.toBeInstanceOf(ValidationError);
    expect(called).toBe(false);
  });
  it('IBK-SEC-004: exposes the backend', () => {
    expect(client.backend).toBe('simulated');
  });
  it('live mode resolves connections and supports defaults', () => {
    const live = createBankClient({
      connectors: [withFields],
      backend: 'live',
      defaultConnections: { acme: { clientId: 'd', clientSecret: 's' } },
    });
    expect(() => live.session('acme')).not.toThrow();
    const strict = createBankClient({ connectors: [withFields], backend: 'live' });
    expect(() => strict.session('acme')).toThrow(ConnectionError);
  });
  it('createClientFromEnv reads the feature flag and allowlist', () => {
    const c = createClientFromEnv({ env: { BANK_BACKEND: 'mock' }, connectors: [sim], simulation: () => simulationFor([sim]) });
    expect(c.backend).toBe('simulated');
    expect(createClientFromEnv({ env: { BANK_BACKEND: 'live' }, connectors: [sim], simulation: () => simulationFor([sim]) }).backend).toBe(
      'live',
    );
    expect(() => createClientFromEnv({ env: { BANK_BACKEND: 'prod' }, connectors: [sim], simulation: () => simulationFor([sim]) })).toThrow(
      /BANK_BACKEND/,
    );
  });
});

describe('IBK-PAY-002: classification of thrown errors', () => {
  it('only provably-unsent failures are REJECTED; everything else is OUTCOME_UNKNOWN', () => {
    expect(classifyThrown('M', new TransportError('AUTH', 'token', { definitelyNotProcessed: true })).result).toBe('REJECTED');
    expect(classifyThrown('M', new BankError('VALIDATION_FAILED', 'bad', { httpStatus: 422 })).result).toBe('REJECTED');
    expect(classifyThrown('M', new TransportError('TIMEOUT', 't'))).toMatchObject({ result: 'OUTCOME_UNKNOWN', category: 'TIMEOUT' });
    expect(classifyThrown('M', new BankError('INTERNAL_ERROR', 'x', { httpStatus: 500 })).result).toBe('OUTCOME_UNKNOWN');
    const unknown = classifyThrown('M', new Error('parser crashed'));
    expect(unknown.result).toBe('OUTCOME_UNKNOWN');
    if (unknown.result === 'OUTCOME_UNKNOWN') expect(unknown.guidance).toMatch(/Never resend with a different messageId/);
  });
});

describe('OAuth JSON transport', () => {
  let base = '';
  let tokens = 0;
  const seen: { url: string; auth: string | undefined; clientId: string | undefined }[] = [];
  let mode: 'ok' | 'always401' | 'redirect' | 'slow' | 'badtoken' = 'ok';
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _;
    if (req.url === '/token') {
      if (mode === 'badtoken') return res.writeHead(401).end('{}');
      tokens++;
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: `t${tokens}`, expires_in: 3600 }));
    }
    seen.push({ url: req.url ?? '', auth: req.headers.authorization, clientId: req.headers['client-id'] as string | undefined });
    if (mode === 'redirect') return res.writeHead(302, { location: 'https://evil.example/' }).end();
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 300));
    if (mode === 'always401' || (mode === 'ok' && seen.length === 2)) return res.writeHead(401).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterAll(() => {
    server.close();
  });
  const client = (timeoutMs = 2000) =>
    createOAuthJsonClient({
      baseUrl: base,
      tokenUrl: `${base}/token`,
      clientId: 'id',
      clientSecret: 's',
      scope: 'x',
      timeoutMs,
      headers: () => ({ 'client-id': 'id' }),
    });

  it('IBK-AUTH-001: refreshes the token once on 401, and only once', async () => {
    mode = 'ok';
    const c = client();
    expect((await c.post('/a', {})).status).toBe(200);
    expect(seen[0]).toMatchObject({ auth: 'Bearer t1', clientId: 'id' });
    expect((await c.post('/a', {})).status).toBe(200);
    expect(seen[2]?.auth).toBe('Bearer t2');
    mode = 'always401';
    const before = seen.length;
    expect((await c.post('/a', {})).status).toBe(401);
    expect(seen.length - before).toBe(2);
  });
  it('IBK-SEC-002: refuses redirects', async () => {
    mode = 'redirect';
    await expect(client().post('/a', {})).rejects.toBeInstanceOf(TransportError);
  });
  it('times out as TransportError(TIMEOUT)', async () => {
    mode = 'slow';
    await expect(client(100).post('/a', {})).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });
  it('token failure is definitely-not-processed', async () => {
    mode = 'badtoken';
    await expect(client().post('/a', {})).rejects.toMatchObject({ kind: 'AUTH', details: { definitelyNotProcessed: true } });
  });
});
