// The CLI, stdio MCP server and Lambda bundle as real processes and artefacts.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { BIN, ibk, ROOT } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'ibk-e2e-'));

describe('ibk binary', () => {
  it('validates identifiers with exit codes', async () => {
    expect(await ibk(['iban', 'GB52SIMB00000012345678'])).toMatchObject({ code: 0 });
    expect((await ibk(['iban', 'GB00SIMB00000012345678'])).code).toBe(1);
    expect((await ibk(['bic', 'BAMCSVSS'])).stdout).toMatch(/country SV/);
  });
  it('builds, writes and validates a pain.001 file', async () => {
    const batch = join(dir, 'batch.json');
    writeFileSync(
      batch,
      JSON.stringify({
        messageId: 'E2E-CLI',
        country: 'SV',
        debtorName: 'E2E',
        debtorAccount: { number: '1' },
        requestedExecutionDate: '2026-01-02',
        transfers: [
          {
            endToEndId: 'a',
            route: 'INTRABANK',
            amount: '1.00',
            currency: 'USD',
            creditor: { name: 'A' },
            creditorAccount: { number: '2' },
            purposeCode: '26.3',
          },
        ],
      }),
    );
    const built = await ibk(['build', 'pain001', batch, '--bank-bic', 'BAMCSVSS']);
    expect(built.code).toBe(0);
    const pain = join(dir, 'pain.json');
    writeFileSync(pain, built.stdout);
    expect(await ibk(['validate', pain, '--connector', 'bac'])).toMatchObject({ code: 0 });
  });
  it('runs conformance for a plugin loaded from a module path', async () => {
    const r = await ibk(['conformance', '--plugin', './examples/acme-connector/index.ts']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/12\/12 passed/);
  });
});

describe('MCP over stdio', () => {
  it('reads the connection from BAC_* env vars and reports the backend', async () => {
    const c = new Client({ name: 'e2e', version: '1.0.0' });
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [...BIN, 'mcp'],
        cwd: ROOT,
        env: { ...getDefaultEnvironment(), BANK_BACKEND: 'live', BAC_CLIENT_ID: 'only-id' },
      }),
    );
    const info = await c.callTool({ name: 'bank_get_service_info', arguments: {} });
    expect(info.structuredContent).toMatchObject({ backend: 'LIVE' });
    // clientId came from env; the missing secret is reported as a configuration problem.
    const r = await c.callTool({ name: 'bank_get_balance', arguments: { bank: 'bac', country: 'HN', account_number: '1' } });
    expect(JSON.stringify(r.content)).toMatch(/missing clientSecret, clientBic, ownerBic/);
    await c.close();
  });
});

describe('Lambda bundle', () => {
  it('bundles to one file and serves GraphQL', async () => {
    execFileSync(process.execPath, ['packages/lambda/scripts/bundle.mjs'], { cwd: ROOT });
    const mod = (await import(pathToFileURL(join(ROOT, 'packages/lambda/build/index.mjs')).href)) as {
      handler: (e: unknown) => Promise<{ statusCode: number; body: string }>;
    };
    const r = await mod.handler({
      rawPath: '/graphql',
      headers: { host: 'x', 'content-type': 'application/json' },
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({ query: '{ serviceInfo { backend } }' }),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ data: { serviceInfo: { backend: 'SIMULATED' } } });
  });
});
