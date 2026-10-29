// MCP host. Tools are generated from the installed connectors. Credentials never appear in tool
// arguments (SPEC IBK-SEC-001): they come from the transport (headers) or configuration (env).

import type { BankClient, BankConnector, Connection } from '@iso20022-bank-kit/core';
import {
  BankError,
  ConnectionError,
  connectionFromEnv,
  connectionFromHeaders,
  envName,
  headerName,
  KitError,
  UnsupportedError,
  ValidationError,
} from '@iso20022-bank-kit/core';
import type { PaymentBatch } from '@iso20022-bank-kit/iso20022';
import { CURRENCIES } from '@iso20022-bank-kit/iso20022';
import { createMcpHandler, McpServer, originValidationResponse } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import * as fmt from './format.js';

export const SERVER_NAME = 'iso20022-bank-kit';
export const VERSION = '0.1.0';
const CHARACTER_LIMIT = 25_000;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export type ConnectionResolver = (connector: BankConnector) => Connection | null;

export const connectionsFromEnv =
  (env: Readonly<Record<string, string | undefined>>): ConnectionResolver =>
  (c) =>
    connectionFromEnv(c, env);
export const connectionsFromHeaders =
  (headers: Headers): ConnectionResolver =>
  (c) =>
    connectionFromHeaders(c, headers);

function recovery(e: unknown, client: BankClient, connector: BankConnector | undefined): string {
  if (e instanceof ValidationError)
    return `${e.message}:\n${e.problems.map((p) => `- ${p}`).join('\n')}\nFix the listed problems and call the tool again.`;
  if (e instanceof ConnectionError) {
    const fields = connector?.connectionFields.filter((f) => f.required) ?? [];
    const headers = fields.map((f) => headerName(connector as BankConnector, f)).join(', ');
    const envs = fields.map((f) => envName(connector as BankConnector, f)).join(', ');
    return `${e.message}. The MCP client must send ${headers || 'the connector headers'} (HTTP) or set ${envs || 'the connector env vars'} (stdio). Ask the user to configure them; do not ask for secrets in chat.`;
  }
  if (e instanceof UnsupportedError) return `${e.message}. Call bank_list_connectors to see what each bank supports.`;
  if (e instanceof BankError) {
    const hint: Record<string, string> = {
      UNAUTHORIZED: 'The bank rejected the credentials; ask the user to check the configured client id and secret.',
      FORBIDDEN: 'These credentials cannot access this account or operation.',
      NOT_FOUND: 'Not found: check the account, country or message_id.',
      VALIDATION_FAILED: 'The bank rejected the request: check the account belongs to this client and the country is right.',
      RATE_LIMITED: 'Rate limit exceeded: wait a minute before calling again.',
    };
    return `${e.message}${e.details.bankCode ? ` (bank code ${e.details.bankCode})` : ''}. ${hint[e.category] ?? 'The bank is unavailable or failed: try again later.'}`;
  }
  if (e instanceof KitError) return e.message;
  return client.backend === 'live' ? 'Unexpected error.' : (e as Error).message;
}

export interface BankMcpServerOptions {
  client: BankClient;
  connections: ConnectionResolver;
}

/** A fresh McpServer (create one per request on HTTP, one per connection on stdio). */
export function createBankMcpServer({ client, connections }: BankMcpServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  const ids = client.connectors.map((c) => c.id) as [string, ...string[]];
  const countries = [...new Set(client.connectors.flatMap((c) => c.countries.map((p) => p.code)))] as [string, ...string[]];

  const bank = z
    .enum(ids)
    .default(ids[0])
    .describe(
      `Bank connector: ${client.connectors.map((c) => `${c.id} = ${c.name} (${c.countries.map((p) => p.code).join(', ')})`).join('; ')}`,
    );
  const country = z.enum(countries).describe('ISO 3166 country of the account; must be served by the chosen bank');
  const accountNumber = z.string().min(1).max(34).optional().describe('Local account number. Give either account_number or iban.');
  const iban = z.string().min(15).max(34).optional().describe('IBAN. Required where the bank requires IBAN (see bank_list_connectors).');
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
  const responseFormat = z
    .enum(['markdown', 'json'])
    .default('markdown')
    .describe("'markdown' for readable text, 'json' for structured data");

  const account = (a: { account_number?: string | undefined; iban?: string | undefined }) => {
    if (Boolean(a.account_number) === Boolean(a.iban))
      throw new ValidationError('Invalid account', ['give exactly one of account_number or iban']);
    return a.iban ? { iban: a.iban } : { number: a.account_number as string };
  };

  async function run<T>(bankId: string, fn: (s: ReturnType<BankClient['session']>) => Promise<T>): Promise<T> {
    const connector = client.connectors.find((c) => c.id === bankId);
    try {
      return await fn(client.session(bankId, connector ? connections(connector) : null));
    } catch (e) {
      throw new Error(recovery(e, client, connector));
    }
  }

  const reply = (format: 'markdown' | 'json', data: object, markdown: string) =>
    format === 'json'
      ? { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> }
      : { content: [{ type: 'text' as const, text: markdown }] };

  server.registerTool(
    'bank_get_service_info',
    {
      title: 'Service info',
      description:
        'Whether this server serves the SIMULATED bank or LIVE banks (SPEC IBK-SEC-004), and its version. Call first if unsure whether results are real.',
      inputSchema: z.strictObject({}),
      annotations: { ...READ, openWorldHint: false },
    },
    async () => {
      const info = { backend: client.backend === 'live' ? 'LIVE' : 'SIMULATED', version: VERSION, connectors: ids };
      return reply('json', info, '');
    },
  );

  server.registerTool(
    'bank_list_connectors',
    {
      title: 'List banks',
      description:
        'Lists installed bank connectors with countries (BIC, currency, IBAN rule, clearing codes) and capabilities (statement formats, routes). No bank call.',
      inputSchema: z.strictObject({ response_format: responseFormat }),
      annotations: { ...READ, openWorldHint: false },
    },
    async ({ response_format }) => {
      const data = {
        connectors: client.connectors.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          countries: c.countries,
          capabilities: c.capabilities,
        })),
      };
      const md = client.connectors
        .map((c) =>
          [
            `## ${c.name} (\`${c.id}\`)`,
            `Formats: ${c.capabilities.statementFormats.join(', ') || 'none'} · Routes: ${c.capabilities.routes.join(', ')}`,
            '',
            '| Country | Code | BIC | Currency | IBAN | Intrabank code | Sample clearing codes |',
            '|---|---|---|---|---|---|---|',
            ...c.countries.map(
              (p) =>
                `| ${p.name} | ${p.code} | ${p.bankBic} | ${p.localCurrency} | ${p.requiresIban ? 'required' : 'no'} | ${p.intrabankClearingCode ?? '—'} | ${
                  Object.entries(p.sampleClearingCodes ?? {})
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ') || '—'
                } |`,
            ),
          ].join('\n'),
        )
        .join('\n\n');
      return reply(response_format, data, md);
    },
  );

  server.registerTool(
    'bank_get_balance',
    {
      title: 'Get account balance',
      description:
        'Current available balance of one account (ISO 20022 camt.052).\n\nExample: "balance of Honduras account 999888666 at BAC" -> bank="bac", country="HN", account_number="999888666".\nUse bank_get_statement for movements.',
      inputSchema: z.strictObject({ bank, country, account_number: accountNumber, iban, response_format: responseFormat }),
      annotations: READ,
    },
    async (a) => {
      const r = await run(a.bank, (s) => s.getBalance({ country: a.country, account: account(a) }));
      return reply(a.response_format, r, fmt.balance(r));
    },
  );

  server.registerTool(
    'bank_get_statement',
    {
      title: 'Get account statement',
      description:
        'Movements and balances of one account for a date range. format: CAMT053 (default; includes endToEndId), MT940 (end of day) or MT942 (intraday; from_time/to_time, debit/credit totals). Every format returns the same fields. Entries are paginated: the result gives next_offset when more remain.',
      inputSchema: z.strictObject({
        bank,
        country,
        account_number: accountNumber,
        iban,
        from_date: date.describe('First day, YYYY-MM-DD'),
        to_date: date.optional().describe('Last day; defaults to from_date'),
        format: z.enum(['CAMT053', 'MT940', 'MT942']).default('CAMT053'),
        from_time: z
          .string()
          .regex(/^\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/)
          .optional()
          .describe('MT942 only'),
        to_time: z
          .string()
          .regex(/^\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/)
          .optional()
          .describe('MT942 only'),
        credit_debit: z.enum(['CREDIT', 'DEBIT']).optional().describe('Only credits or only debits'),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormat,
      }),
      annotations: READ,
    },
    async (a) => {
      const stmt = await run(a.bank, (s) =>
        s.getStatement({
          country: a.country,
          account: account(a),
          format: a.format,
          fromDate: a.from_date,
          ...(a.to_date ? { toDate: a.to_date } : {}),
          ...(a.from_time ? { fromTime: a.from_time } : {}),
          ...(a.to_time ? { toTime: a.to_time } : {}),
        }),
      );
      const all = a.credit_debit ? stmt.entries.filter((e) => e.creditDebit === a.credit_debit) : stmt.entries;
      const render = (entries: typeof all) => {
        const next = a.offset + entries.length;
        const page = {
          ...stmt,
          entries,
          total_entries: all.length,
          offset: a.offset,
          count: entries.length,
          has_more: all.length > next,
          ...(all.length > next ? { next_offset: next } : {}),
        };
        return { page, text: a.response_format === 'json' ? JSON.stringify(page, null, 2) : fmt.statement(page) };
      };
      let entries = all.slice(a.offset, a.offset + a.limit);
      let result = render(entries);
      while (entries.length > 1 && result.text.length > CHARACTER_LIMIT) {
        entries = entries.slice(0, Math.ceil(entries.length / 2));
        result = render(entries);
      }
      return a.response_format === 'json'
        ? { content: [{ type: 'text' as const, text: result.text }], structuredContent: result.page as unknown as Record<string, unknown> }
        : { content: [{ type: 'text' as const, text: result.text }] };
    },
  );

  server.registerTool(
    'bank_get_payment_status',
    {
      title: 'Get payment status',
      description:
        'Status of a payment batch and each transfer (ISO 20022 pain.002), by the message_id used in bank_initiate_payment. state: IN_PROGRESS, COMPLETED, PARTIAL, FAILED or UNKNOWN. Always call this after bank_initiate_payment returns OUTCOME UNKNOWN.',
      inputSchema: z.strictObject({
        bank,
        country: country.describe('Country of the debtor account used for the payment'),
        message_id: z.string().min(1).max(35),
        transaction_state: z
          .enum(['IN_PROGRESS', 'COMPLETED', 'PARTIAL', 'FAILED', 'UNKNOWN'])
          .optional()
          .describe('Only list transfers in this state'),
        response_format: responseFormat,
      }),
      annotations: READ,
    },
    async (a) => {
      const r = await run(a.bank, (s) => s.getPaymentStatus({ country: a.country, messageId: a.message_id }));
      const filtered = a.transaction_state
        ? {
            ...r,
            paymentInfos: r.paymentInfos.map((p) => ({
              ...p,
              transactions: p.transactions.filter((t) => t.state === a.transaction_state),
            })),
          }
        : r;
      return reply(a.response_format, filtered, fmt.paymentStatus(filtered));
    },
  );

  const transfer = z.strictObject({
    end_to_end_id: z.string().min(1).max(35).describe('Unique id for this transfer within the batch'),
    route: z
      .enum(['INTRABANK', 'DOMESTIC_CLEARING', 'CROSS_BORDER'])
      .describe(
        'INTRABANK: same bank. DOMESTIC_CLEARING: other local bank (needs creditor_bank_code). CROSS_BORDER: wire (needs creditor_bank_bic and creditor_address).',
      ),
    amount: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .describe('Decimal string, e.g. "1250.50"'),
    currency: z.enum(CURRENCIES).describe('ISO 4217'),
    creditor_name: z.string().min(1).max(140),
    creditor_id: z.string().max(35).optional(),
    creditor_account_number: z.string().max(34).optional().describe('Give either creditor_account_number or creditor_iban'),
    creditor_iban: z.string().max(34).optional(),
    creditor_account_type: z.enum(['SAVINGS', 'CHECKING', 'LOAN']).optional(),
    creditor_bank_code: z.string().max(11).optional().describe('Local clearing code (see bank_list_connectors)'),
    creditor_bank_bic: z.string().max(11).optional(),
    creditor_address: z.strictObject({ town: z.string(), country: z.string().length(2), line: z.string() }).optional(),
    purpose_code: z.string().max(35).optional(),
    references: z.array(z.string().max(35)).optional().describe('Invoice / remittance references'),
  });

  server.registerTool(
    'bank_initiate_payment',
    {
      title: 'Initiate payment batch',
      description: `MOVES MONEY. Submits transfers from one debtor account (ISO 20022 pain.001). Confirm the details with the user first.

message_id is the idempotency key: generate a new unique one (max 35 chars) per new batch and reuse the SAME one if you ever resend it. A resend with the same message_id returns REJECTED (duplicate) instead of paying twice.

Results:
  - SUBMITTED: accepted; follow it with bank_get_payment_status.
  - REJECTED: not processed; fix and resubmit. duplicate=true means it already exists.
  - OUTCOME UNKNOWN: the debit MAY have happened. Do NOT resend; call bank_get_payment_status with the same message_id.`,
      inputSchema: z.strictObject({
        bank,
        message_id: z.string().min(1).max(35),
        country: country.describe('Country of the debtor account'),
        debtor_name: z.string().min(1).max(140),
        debtor_account_number: accountNumber,
        debtor_iban: iban,
        requested_execution_date: date,
        purpose: z.enum(['SUPPLIERS', 'PAYROLL']).default('SUPPLIERS'),
        method: z.enum(['TRANSFER', 'CHECK']).default('TRANSFER'),
        transfers: z.array(transfer).min(1).max(500),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (a) => {
      const batch: PaymentBatch = {
        messageId: a.message_id,
        country: a.country,
        debtorName: a.debtor_name,
        debtorAccount: a.debtor_iban ? { iban: a.debtor_iban } : { number: a.debtor_account_number ?? '' },
        requestedExecutionDate: a.requested_execution_date,
        purpose: a.purpose,
        method: a.method,
        transfers: a.transfers.map((t) => ({
          endToEndId: t.end_to_end_id,
          route: t.route,
          amount: t.amount,
          currency: t.currency,
          creditor: {
            name: t.creditor_name,
            ...(t.creditor_id ? { id: t.creditor_id } : {}),
            ...(t.creditor_address ? { address: t.creditor_address } : {}),
          },
          creditorAccount: t.creditor_iban ? { iban: t.creditor_iban } : { number: t.creditor_account_number ?? '' },
          ...(t.creditor_account_type ? { creditorAccountType: t.creditor_account_type } : {}),
          ...(t.creditor_bank_code ? { creditorBankCode: t.creditor_bank_code } : {}),
          ...(t.creditor_bank_bic ? { creditorBankBic: t.creditor_bank_bic } : {}),
          ...(t.purpose_code ? { purposeCode: t.purpose_code } : {}),
          ...(t.references ? { references: t.references } : {}),
        })),
      };
      const outcome = await run(a.bank, (s) => s.initiatePayment(batch));
      return {
        content: [{ type: 'text' as const, text: `${fmt.paymentOutcome(outcome)}\n\n${JSON.stringify(outcome, null, 2)}` }],
        structuredContent: outcome as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

export interface McpFetchOptions {
  client: BankClient;
  /** Browser origins allowed to call (requests with no Origin header are not browsers). */
  allowedOrigins?: readonly string[];
}

/** Stateless Streamable HTTP handler (Request -> Response); connection comes from request headers. */
export function createMcpFetch({ client, allowedOrigins = [] }: McpFetchOptions): (request: Request) => Promise<Response> {
  const handler = createMcpHandler(
    ({ requestInfo }) =>
      createBankMcpServer({ client, connections: requestInfo ? connectionsFromHeaders(requestInfo.headers) : () => null }),
    {
      responseMode: 'json',
      onerror: (e) => console.error('[mcp]', e.message),
    },
  );
  return async (request) => {
    if (request.headers.get('origin')) {
      const rejected = originValidationResponse(request, [...allowedOrigins]);
      if (rejected) return rejected;
    }
    return handler.fetch(request);
  };
}
