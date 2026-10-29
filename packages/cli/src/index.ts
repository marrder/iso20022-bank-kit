// ibk: developer tools for ISO 20022 bank integrations.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runConformance } from '@iso20022-bank-kit/conformance';
import { BAC_CURRENCY_ALIASES, BAC_MESSAGE_PROFILE, decodeMtFile, wrap } from '@iso20022-bank-kit/connector-bac';
import { validatePaymentBatch } from '@iso20022-bank-kit/core';
import { buildSdl } from '@iso20022-bank-kit/graphql';
import {
  buildCustomerCreditTransferInitiation,
  buildStatementDocument,
  detectMessage,
  ibanCountry,
  ibanFromBban,
  isoDateTime,
  isValidBic,
  isValidIban,
  isWellFormedIban,
  jsonSchemaFor,
  MESSAGE_SCHEMAS,
  type MessageId,
  type PaymentBatch,
  parseCustomerCreditTransferInitiation,
} from '@iso20022-bank-kit/iso20022';
import { connectionsFromEnv, createBankMcpServer } from '@iso20022-bank-kit/mcp';
import { mtToStatement } from '@iso20022-bank-kit/swift-mt';
import { clientFor, resolveConnectors, serve } from './host.js';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  readFile: (path: string) => string;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  env: process.env,
  readFile: (p) => readFileSync(p, 'utf8'),
};

export const HELP = `ibk — ISO 20022 Bank Kit tools

Usage: ibk <command> [options]

Messages
  validate <file>                 Validate a pain.001/camt.060/tsmt.038/camt.052/camt.053/pain.002/admi JSON message
                                    --connector <id>  also apply that bank's payment rules (pain.001)
  mt <file> [--to json|camt053]   Parse MT940/MT942 (raw FIN or BAC "F{base64}" JSON) into a statement or camt.053
  build pain001 <batch.json>      Build a pain.001 from a PaymentBatch JSON
                                    --client-bic, --owner-bic, --bank-bic, --profile bac|iso
  schema [--out <dir>]            Print or write JSON Schemas for every supported message

Identifiers
  iban <value>                    Check an IBAN (format + mod-97)
  iban --make <CC> <bban>         Build a valid IBAN from country and BBAN
  bic <value>                     Check a BIC

Servers
  serve [--port 4000]             GraphQL (/graphql) and MCP (/mcp) over HTTP
  mcp                             MCP over stdio
  sdl                             Print the GraphQL schema for the installed connectors

Plugins
  conformance                     Run the SPEC conformance suite against a connector
                                    --connector <id> | --plugin <module>  --country <CC>  --iban <IBAN>

Common options
  --connectors bac,sim            Built-in connectors to install (default: bac,sim)
  --plugin <module>               Load an extra connector (repeatable)

Environment
  BANK_BACKEND=simulated|live     Feature flag (default simulated)
  BANK_ALLOWED_HOSTS              Live endpoint allowlist (default: from connectors)
  <ID>_<FIELD>                    Connection for stdio MCP, e.g. BAC_CLIENT_ID, BAC_CLIENT_SECRET
`;

/** Accepts a bare Document, {AppHdr, Document}, or BAC's {file|File: {Envelope}}. */
function documentOf(json: unknown): unknown {
  const j = json as { file?: { Envelope?: { Document?: unknown } }; File?: { Envelope?: { Document?: unknown } }; Document?: unknown };
  return j.file?.Envelope?.Document ?? j.File?.Envelope?.Document ?? j.Document ?? json;
}

export async function run(argv: string[], io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      connector: { type: 'string' },
      connectors: { type: 'string' },
      plugin: { type: 'string', multiple: true },
      to: { type: 'string' },
      out: { type: 'string' },
      port: { type: 'string' },
      make: { type: 'boolean' },
      country: { type: 'string' },
      iban: { type: 'string' },
      profile: { type: 'string' },
      'client-bic': { type: 'string' },
      'owner-bic': { type: 'string' },
      'bank-bic': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const plugins = values.plugin ?? [];

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(HELP);
      return 0;

    case 'validate': {
      const file = positionals[0];
      if (!file) return usage(io, 'validate <file>');
      const json = JSON.parse(io.readFile(file)) as unknown;
      const doc = documentOf(json);
      const id = detectMessage(doc);
      if (!id) {
        io.err('Could not recognise the message (no known root element).');
        return 1;
      }
      const r = MESSAGE_SCHEMAS[id].safeParse(doc);
      const problems = r.success ? [] : r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      if (r.success && id === 'pain.001.001.03') {
        const connector = values.connector
          ? (await resolveConnectors(values.connector, plugins)).find((c) => c.id === values.connector)
          : undefined;
        const batch = parseCustomerCreditTransferInitiation(doc, {
          intrabankCodes: connector?.countries.map((c) => c.intrabankClearingCode ?? '') ?? [],
        });
        problems.push(...validatePaymentBatch(batch, connector));
      }
      if (problems.length) {
        io.err(`✗ ${id}: ${problems.length} problem(s)`);
        for (const p of problems) io.err(`  - ${p}`);
        return 1;
      }
      io.out(`✓ ${id} is valid`);
      return 0;
    }

    case 'mt': {
      const file = positionals[0];
      if (!file) return usage(io, 'mt <file> [--to json|camt053]');
      const raw = io.readFile(file).trim();
      const text = raw.startsWith('{"') || raw.startsWith('{\n') ? decodeMtFile((JSON.parse(raw) as { File: string }).File) : raw;
      const stmt = mtToStatement(text, { currencyAliases: BAC_CURRENCY_ALIASES });
      if ((values.to ?? 'json') === 'camt053') {
        const cd = (x: string) => (x === 'CREDIT' ? 'CREDIT' : 'DEBIT') as 'CREDIT' | 'DEBIT';
        const doc = buildStatementDocument({
          messageId: stmt.bankMessageId ?? 'MT',
          createdAt: stmt.createdAt ?? isoDateTime(new Date()),
          statementId: stmt.statementId ?? 'MT',
          sequenceNumber: Number(stmt.sequenceNumber?.split('/')[0] ?? 1),
          account: stmt.account.iban ? { iban: stmt.account.iban } : { number: stmt.account.number ?? '' },
          currency: stmt.account.currency ?? 'XXX',
          fromDateTime: `${stmt.balances[0]?.date ?? stmt.entries[0]?.bookingDate ?? ''}T00:00:00`,
          toDateTime: `${stmt.balances.at(-1)?.date ?? stmt.entries.at(-1)?.bookingDate ?? ''}T23:59:59`,
          balances: stmt.balances
            .filter((b) => b.type !== 'UNKNOWN')
            .map((b) => ({
              type: b.type as 'OPENING_BOOKED',
              creditDebit: cd(b.creditDebit),
              amount: b.amount ?? '0',
              ...(b.date ? { date: b.date } : {}),
            })),
          entries: stmt.entries.map((e) => ({
            reference: e.reference ?? 'NONREF',
            amount: e.amount ?? '0',
            creditDebit: cd(e.creditDebit),
            bookingDate: e.bookingDate ?? '',
            valueDate: e.valueDate ?? '',
            transactionType: e.transactionTypeCode ?? 'MSC',
            ...(e.description ? { description: e.description } : {}),
          })),
        });
        io.out(JSON.stringify(doc, null, 2));
      } else {
        io.out(JSON.stringify({ ...stmt, raw: undefined }, null, 2));
      }
      return 0;
    }

    case 'build': {
      if (positionals[0] !== 'pain001' || !positionals[1]) return usage(io, 'build pain001 <batch.json> [--profile bac|iso]');
      const batch = JSON.parse(io.readFile(positionals[1])) as PaymentBatch;
      const bac = (values.profile ?? 'bac') === 'bac';
      const msg = buildCustomerCreditTransferInitiation({
        parties: {
          clientBic: values['client-bic'] ?? 'DUMMYMASTER',
          ownerBic: values['owner-bic'] ?? 'DUMMYORDENA',
          bankBic: values['bank-bic'] ?? 'BANKXXXX',
        },
        ...(bac ? { profile: BAC_MESSAGE_PROFILE } : {}),
        batch,
        createdAt: isoDateTime(new Date()),
      });
      io.out(JSON.stringify(bac ? wrap(msg) : msg, null, 2));
      return 0;
    }

    case 'schema': {
      const ids = Object.keys(MESSAGE_SCHEMAS) as MessageId[];
      if (values.out) {
        mkdirSync(values.out, { recursive: true });
        for (const id of ids) writeFileSync(join(values.out, `${id}.schema.json`), `${JSON.stringify(jsonSchemaFor(id), null, 2)}\n`);
        io.out(`Wrote ${ids.length} schemas to ${values.out}`);
      } else {
        io.out(JSON.stringify(Object.fromEntries(ids.map((id) => [id, jsonSchemaFor(id)])), null, 2));
      }
      return 0;
    }

    case 'iban': {
      if (values.make) {
        const [cc, bban] = positionals;
        if (!cc || !bban) return usage(io, 'iban --make <CC> <bban>');
        io.out(ibanFromBban(cc, bban));
        return 0;
      }
      const v = positionals[0];
      if (!v) return usage(io, 'iban <value>');
      if (isValidIban(v)) {
        io.out(`✓ valid IBAN (${ibanCountry(v)})`);
        return 0;
      }
      io.err(isWellFormedIban(v) ? '✗ well-formed, but the check digits are wrong' : '✗ not an IBAN');
      return 1;
    }

    case 'bic': {
      const v = positionals[0];
      if (!v) return usage(io, 'bic <value>');
      if (isValidBic(v)) {
        io.out(
          `✓ valid BIC: bank ${v.slice(0, 4)}, country ${v.slice(4, 6)}, location ${v.slice(6, 8)}${v.length === 11 ? `, branch ${v.slice(8)}` : ''}`,
        );
        return 0;
      }
      io.err('✗ not a BIC (ISO 9362: 4 letters bank, 2 letters country, 2 alphanumerics location, optional 3 branch)');
      return 1;
    }

    case 'sdl': {
      io.out(buildSdl(await resolveConnectors(values.connectors, plugins)));
      return 0;
    }

    case 'serve': {
      const connectors = await resolveConnectors(values.connectors, plugins);
      await serve(clientFor(connectors, io.env), { port: Number(values.port ?? io.env.PORT ?? 4000), log: io.err });
      return await new Promise<number>(() => {});
    }

    case 'mcp': {
      const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
      const connectors = await resolveConnectors(values.connectors, plugins);
      const client = clientFor(connectors, io.env);
      serveStdio(() => createBankMcpServer({ client, connections: connectionsFromEnv(io.env) }));
      io.err(`iso20022-bank-kit MCP on stdio (${client.backend})`);
      return await new Promise<number>(() => {});
    }

    case 'conformance': {
      const connectors = await resolveConnectors(values.plugin?.length ? '' : (values.connector ?? 'bac'), plugins);
      const connector = connectors[0];
      if (!connector) return usage(io, 'conformance --connector <id> | --plugin <module>');
      const results = await runConformance({
        connector,
        ...(values.country ? { country: values.country } : {}),
        ...(values.iban ? { account: { iban: values.iban } } : {}),
      });
      io.out(`Conformance: ${connector.name} ${connector.version}${values.country ? ` (${values.country})` : ''}\n`);
      for (const r of results)
        io.out(`${r.ok ? '✓' : '✗'} ${r.requirements.join(', ').padEnd(56)} ${r.title}${r.error ? `\n    ${r.error}` : ''}`);
      const failed = results.filter((r) => !r.ok).length;
      io.out(`\n${results.length - failed}/${results.length} passed`);
      return failed ? 1 : 0;
    }

    default:
      io.err(`Unknown command "${command}"\n`);
      io.err(HELP);
      return 2;
  }
}

function usage(io: Io, text: string): number {
  io.err(`Usage: ibk ${text}`);
  return 2;
}
