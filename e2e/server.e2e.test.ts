// End to end over real sockets: the CLI server, GraphQL over HTTP, MCP over Streamable HTTP, and the
// Postman collection executed request by request with its pm.test scripts.

import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect as chaiExpect } from 'chai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROOT, startServer } from './helpers.js';

let url = '';
let child: ChildProcess;
beforeAll(async () => {
  ({ url, child } = await startServer({ BANK_BACKEND: 'simulated' }));
});
afterAll(() => {
  child?.kill();
});

const gql = async (query: string, variables?: unknown) => {
  const res = await fetch(`${url}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as { data?: any; errors?: any[] };
};

describe('GraphQL over HTTP', () => {
  it('serves the generated schema and a full payment flow', async () => {
    expect((await gql('{ serviceInfo { backend } }')).data.serviceInfo.backend).toBe('SIMULATED');
    const input = {
      messageId: `E2E-${Date.now()}`,
      country: 'GT',
      debtorName: 'E2E',
      debtorAccount: { number: '12345' },
      requestedExecutionDate: new Date().toISOString().slice(0, 10),
      transfers: [
        {
          endToEndId: 'E2E-1',
          route: 'INTRABANK',
          amount: '1.00',
          currency: 'GTQ',
          creditor: { name: 'A' },
          creditorAccount: { number: '1' },
        },
      ],
    };
    const pay = await gql('mutation($i: PaymentBatchInput!) { bac { initiatePayment(input: $i) { __typename } } }', { i: input });
    expect(pay.data.bac.initiatePayment.__typename).toBe('PaymentSubmitted');
    const s = await gql('query($id: ID!) { bac { paymentStatus(country: GT, messageId: $id) { state } } }', { id: input.messageId });
    expect(s.data.bac.paymentStatus.state).toBe('IN_PROGRESS');
  });
  it('serves GraphiQL to browsers in simulated mode', async () => {
    const res = await fetch(`${url}/graphql`, { headers: { accept: 'text/html' } });
    expect(await res.text()).toMatch(/GraphiQL/i);
  });
});

describe('MCP over Streamable HTTP', () => {
  it('lists and calls tools over the network', async () => {
    const c = new Client({ name: 'e2e', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toContain('bank_initiate_payment');
    const r = await c.callTool({
      name: 'bank_get_balance',
      arguments: { bank: 'sim', country: 'MX', account_number: '7', response_format: 'json' },
    });
    expect((r.structuredContent as { balances: { currency: string }[] }).balances[0]?.currency).toBe('MXN');
    await c.close();
  });
});

// ------------------------------------------------------------------ Postman collection

interface PostmanRequest {
  file: string;
  url: string;
  method: string;
  headers?: { key: string; value: string }[];
  body?: { content: string };
  scripts?: { type: string; code: string }[];
}

function requestsIn(dir: string): PostmanRequest[] {
  const items = readdirSync(dir)
    .filter((n) => n !== '.resources')
    .map((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) {
        const def = parse(readFileSync(join(p, '.resources/definition.yaml'), 'utf8')) as { order?: number };
        return { order: def.order ?? 0, list: requestsIn(p) };
      }
      const r = parse(readFileSync(p, 'utf8')) as PostmanRequest & { order?: number };
      return { order: r.order ?? 0, list: [{ ...r, file: n }] };
    });
  return items.sort((a, b) => a.order - b.order).flatMap((i) => i.list);
}

describe('Postman collection', () => {
  const dir = join(ROOT, 'postman/collections/iso20022-bank-kit');
  const collection = parse(readFileSync(join(dir, '.resources/definition.yaml'), 'utf8')) as {
    variables?: { key: string; value: string }[];
    scripts?: { type: string; code: string }[];
  };
  const envFile = parse(readFileSync(join(ROOT, 'postman/environments/Local (simulated).environment.yaml'), 'utf8')) as {
    values: { key: string; value: string }[];
  };

  it('runs green with its pm.test scripts (shim)', async () => {
    const env = Object.fromEntries(envFile.values.map((v) => [v.key, v.value]));
    env.base_url = url;
    const vars: Record<string, string> = Object.fromEntries((collection.variables ?? []).map((v) => [v.key, v.value]));
    const failures: string[] = [];
    let assertions = 0;
    for (const req of requestsIn(dir)) {
      const local: Record<string, string> = {};
      const get = (k: string) => local[k] ?? vars[k] ?? env[k];
      const pm: Record<string, any> = {
        variables: { set: (k: string, v: string) => (local[k] = v), get },
        collectionVariables: { set: (k: string, v: string) => (vars[k] = v), get: (k: string) => vars[k] },
        environment: { get: (k: string) => env[k] },
        expect: chaiExpect,
        test: (name: string, fn: () => void) => {
          assertions++;
          try {
            fn();
          } catch (e) {
            failures.push(`${req.file} › ${name}: ${(e as Error).message}`);
          }
        },
      };
      const runScripts = (type: string, scripts: { type: string; code: string }[] = []) => {
        for (const s of scripts.filter((x) => x.type === type)) new Function('pm', s.code)(pm);
      };
      runScripts('http:beforeRequest', collection.scripts);
      runScripts('beforeRequest', req.scripts);
      const resolve = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => get(k) ?? '');
      const res = await fetch(resolve(req.url), {
        method: req.method,
        headers: Object.fromEntries((req.headers ?? []).map((h) => [h.key, resolve(h.value)])),
        ...(req.body ? { body: resolve(req.body.content) } : {}),
      });
      const text = await res.text();
      pm.response = {
        code: res.status,
        text: () => text,
        json: () => JSON.parse(text),
        to: { have: { status: (n: number) => chaiExpect(res.status).to.equal(n) } },
      };
      runScripts('afterResponse', req.scripts);
    }
    expect(failures).toEqual([]);
    expect(assertions).toBeGreaterThan(40);
  });

  it.runIf(process.env.E2E_POSTMAN_CLI === '1')('runs green with the real Postman CLI', () => {
    const env = join(ROOT, 'postman/environments/Local (simulated).environment.yaml');
    const out = execFileSync('postman', ['collection', 'run', dir, '-e', env, '--env-var', `base_url=${url}`], { encoding: 'utf8' });
    expect(out).toMatch(/assertions\s*│?\s*\|?\s*\d+\s*\|?\s*│?\s*0/);
  });
});
