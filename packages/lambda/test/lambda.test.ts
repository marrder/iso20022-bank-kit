import { createApp, handler } from '@iso20022-bank-kit/lambda';
import { describe, expect, it } from 'vitest';

const event = (path: string, body: unknown, extra: Record<string, unknown> = {}) => ({
  rawPath: path,
  rawQueryString: '',
  headers: { host: 'abc.lambda-url.us-east-1.on.aws', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  requestContext: { http: { method: 'POST' } },
  body: Buffer.from(JSON.stringify(body)).toString('base64'),
  isBase64Encoded: true,
  ...extra,
});

describe('lambda handler', () => {
  it('serves GraphQL (payload v2, base64 body)', async () => {
    const r = await handler(event('/graphql', { query: '{ serviceInfo { backend } }' }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ data: { serviceInfo: { backend: 'SIMULATED' } } });
  });
  it('serves MCP at /mcp', async () => {
    const r = await handler(
      event(
        '/mcp',
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        {
          headers: {
            host: 'x',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-06-18',
          },
        },
      ),
    );
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('bank_initiate_payment');
  });
  it('honours BANK_CONNECTORS and rejects unknown ones', async () => {
    const app = await createApp({ BANK_CONNECTORS: 'sim' });
    expect(app.client.connectors.map((c) => c.id)).toEqual(['sim']);
    await expect(createApp({ BANK_CONNECTORS: 'nope' })).rejects.toThrow(/Unknown connector/);
  });
});
