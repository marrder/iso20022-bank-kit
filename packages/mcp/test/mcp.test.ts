import { bacConnector } from '@iso20022-bank-kit/connector-bac';
import { createBankClient } from '@iso20022-bank-kit/core';
import { connectionsFromHeaders, createBankMcpServer, createMcpFetch } from '@iso20022-bank-kit/mcp';
import { createSimulatedConnector, simulationFor, today, yesterday } from '@iso20022-bank-kit/simulator';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

const connectors = [bacConnector, createSimulatedConnector()];
const simulated = () => createBankClient({ connectors, backend: 'simulated', simulation: simulationFor(connectors) });

async function connect(client = simulated()) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createBankMcpServer({ client, connections: () => null }).connect(b);
  const c = new Client({ name: 'test', version: '1.0.0' });
  await c.connect(a);
  return c;
}
const text = (r: { content: unknown }) => (r.content as { text: string }[]).map((c) => c.text).join('\n');

const pay = (message_id: string, extra: Record<string, unknown> = {}) => ({
  bank: 'bac',
  message_id,
  country: 'HN',
  debtor_name: 'Example',
  debtor_account_number: '999888666',
  requested_execution_date: today(),
  transfers: [
    {
      end_to_end_id: `${message_id}-1`,
      route: 'INTRABANK',
      amount: '10.00',
      currency: 'HNL',
      creditor_name: 'A',
      creditor_account_number: '1',
    },
    {
      end_to_end_id: `${message_id}-2`,
      route: 'DOMESTIC_CLEARING',
      creditor_bank_code: '001',
      amount: '5.00',
      currency: 'HNL',
      creditor_name: 'B',
      creditor_account_number: '2',
    },
  ],
  ...extra,
});

describe('tools', () => {
  it('lists tools with annotations; IBK-SEC-001: no credential arguments', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'bank_get_balance',
      'bank_get_payment_status',
      'bank_get_service_info',
      'bank_get_statement',
      'bank_initiate_payment',
      'bank_list_connectors',
    ]);
    const payTool = tools.find((t) => t.name === 'bank_initiate_payment');
    expect(payTool?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false, idempotentHint: true });
    for (const t of tools) expect(JSON.stringify(t.inputSchema)).not.toMatch(/secret|clientId|client_id|password|token/i);
    expect((payTool!.inputSchema.properties as Record<string, { enum?: string[] }>).bank?.enum).toEqual(['bac', 'sim']);
  });
  it('IBK-SEC-004: service info reports the backend', async () => {
    const r = await (await connect()).callTool({ name: 'bank_get_service_info', arguments: {} });
    expect(r.structuredContent).toMatchObject({ backend: 'SIMULATED', connectors: ['bac', 'sim'] });
  });
  it('balance, paginated statement', async () => {
    const c = await connect();
    expect(
      text(await c.callTool({ name: 'bank_get_balance', arguments: { bank: 'bac', country: 'HN', account_number: '999888666' } })),
    ).toMatch(/# Balance of 999888666 \(HN\)/);
    const page = await c.callTool({
      name: 'bank_get_statement',
      arguments: {
        bank: 'bac',
        country: 'HN',
        account_number: '999888666',
        from_date: yesterday(),
        format: 'MT942',
        limit: 2,
        response_format: 'json',
      },
    });
    expect(page.structuredContent).toMatchObject({ format: 'MT942', total_entries: 5, count: 2, next_offset: 2, has_more: true });
  });
  it('payment outcomes: SUBMITTED, duplicate, OUTCOME_UNKNOWN', async () => {
    const c = await connect();
    expect((await c.callTool({ name: 'bank_initiate_payment', arguments: pay('M-1') })).structuredContent).toMatchObject({
      result: 'SUBMITTED',
    });
    expect((await c.callTool({ name: 'bank_initiate_payment', arguments: pay('M-1') })).structuredContent).toMatchObject({
      result: 'REJECTED',
      duplicate: true,
    });
    const unknown = await c.callTool({ name: 'bank_initiate_payment', arguments: pay('MOCK-500-M') });
    expect(unknown.isError).toBeFalsy();
    expect(text(unknown)).toMatch(/Do NOT resend/);
    const s = await c.callTool({
      name: 'bank_get_payment_status',
      arguments: { bank: 'bac', country: 'HN', message_id: 'M-1', response_format: 'json' },
    });
    expect(s.structuredContent).toMatchObject({ state: 'IN_PROGRESS' });
  });
  it('errors are actionable tool errors', async () => {
    const c = await connect();
    const v = await c.callTool({ name: 'bank_initiate_payment', arguments: pay('M-2', { country: 'CR' }) });
    expect(v.isError).toBe(true);
    expect(text(v)).toMatch(/CR accounts must use iban[\s\S]*Fix the listed problems/);
    const u = await c.callTool({
      name: 'bank_get_statement',
      arguments: { bank: 'sim', country: 'US', account_number: '1', from_date: '2026-01-01', format: 'MT940' },
    });
    expect(text(u)).toMatch(/bank_list_connectors/);
    const both = await c.callTool({
      name: 'bank_get_balance',
      arguments: { bank: 'bac', country: 'HN', account_number: '1', iban: 'CR41010200009998886660' },
    });
    expect(text(both)).toMatch(/exactly one of account_number or iban/);
  });
  it('live mode without a connection says how to configure it, without asking for secrets', async () => {
    const c = await connect(createBankClient({ connectors, backend: 'live', allowedHosts: ['*.baccredomatic.com'] }));
    const r = await c.callTool({ name: 'bank_get_balance', arguments: { bank: 'bac', country: 'HN', account_number: '1' } });
    expect(text(r)).toMatch(/x-bac-client-id[\s\S]*BAC_CLIENT_SECRET[\s\S]*do not ask for secrets in chat/);
  });
});

describe('HTTP transport', () => {
  it('X-<ID>-* headers become the connection', () => {
    expect(connectionsFromHeaders(new Headers({ 'X-Bac-Client-Id': 'h' }))(bacConnector)).toEqual({ clientId: 'h' });
  });
  it('serves Streamable HTTP and rejects browser origins not allowed', async () => {
    const mcp = createMcpFetch({ client: simulated() });
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: (u, init) => mcp(new Request(u, init)) }));
    expect((await c.callTool({ name: 'bank_list_connectors', arguments: {} })).isError).toBeFalsy();
    const blocked = await mcp(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(blocked.status).toBe(403);
  });
});
