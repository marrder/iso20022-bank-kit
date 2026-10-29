import type { BankClient, BankConnector, BankSession, Connection } from '@iso20022-bank-kit/core';
import { BankError, ConnectionError, KitError, UnsupportedError, ValidationError } from '@iso20022-bank-kit/core';
import type { PaymentInfoStatus, Statement } from '@iso20022-bank-kit/iso20022';
import { isIso4217, isIsoDate } from '@iso20022-bank-kit/iso20022';
import { GraphQLError, GraphQLScalarType, type GraphQLSchema, Kind } from 'graphql';
import { createGraphQLError, createSchema, createYoga, type YogaServerInstance } from 'graphql-yoga';
import { buildSdl } from './sdl.js';

export { buildSdl } from './sdl.js';
export const VERSION = '0.1.0';

function stringScalar(name: string, description: string, ok: (v: string) => boolean) {
  const parse = (value: unknown) => {
    if (typeof value !== 'string' || !ok(value))
      throw new GraphQLError(`${name} cannot represent ${JSON.stringify(value)}: ${description}`);
    return value;
  };
  return new GraphQLScalarType({
    name,
    description,
    serialize: (v) => (v == null ? null : String(v)),
    parseValue: parse,
    parseLiteral: (ast) => {
      if (ast.kind !== Kind.STRING) throw new GraphQLError(`${name} must be a string`);
      return parse(ast.value);
    },
  });
}

/**
 * Maps kit errors to GraphQL errors with machine-readable extensions; never includes secrets (IBK-SEC-003).
 * Uses Yoga's createGraphQLError so error masking recognises them regardless of module format.
 */
export function toGraphQLError(e: unknown): unknown {
  if (e instanceof ValidationError) return createGraphQLError(e.message, { extensions: { code: e.code, problems: e.problems } });
  if (e instanceof BankError)
    return createGraphQLError(e.message, {
      extensions: {
        code: e.category,
        httpStatus: e.details.httpStatus ?? null,
        bankCode: e.details.bankCode ?? null,
        traceId: e.details.traceId ?? null,
      },
    });
  if (e instanceof ConnectionError || e instanceof UnsupportedError || e instanceof KitError)
    return createGraphQLError(e.message, { extensions: { code: e.code } });
  return e;
}

const wrap =
  <A extends unknown[], R>(fn: (...a: A) => Promise<R> | R) =>
  async (...a: A) => {
    try {
      return await fn(...a);
    } catch (e) {
      throw toGraphQLError(e);
    }
  };

/** Adds currencyCode next to every currency, and maps non-ISO codes to UNKNOWN. */
const withCurrency = <T extends { currency?: string | null }>(x: T) => ({
  ...x,
  currencyCode: x.currency ?? null,
  currency: x.currency == null ? null : isIso4217(x.currency) ? x.currency : 'UNKNOWN',
});

function deepCurrency(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(deepCurrency);
  if (x && typeof x === 'object') {
    const o = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deepCurrency(v)]));
    return 'currency' in o ? withCurrency(o as { currency?: string | null }) : o;
  }
  return x;
}

export function createGraphQLSchema(client: BankClient): GraphQLSchema {
  const bankField = (c: BankConnector) =>
    wrap((_: unknown, { connection }: { connection?: Connection | null }) => ({ session: client.session(c.id, connection ?? null) }));
  const roots = Object.fromEntries(client.connectors.map((c) => [c.id, bankField(c)]));
  type Ctx = { session: BankSession };

  return createSchema({
    typeDefs: buildSdl(client.connectors),
    resolvers: {
      Date: stringScalar('Date', 'YYYY-MM-DD', isIsoDate),
      DateTime: stringScalar('DateTime', 'ISO 8601 date-time', (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)),
      Time: stringScalar('Time', 'HH:MM:SS[.sss]', (v) => /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?$/.test(v)),
      Decimal: stringScalar('Decimal', 'decimal number as a string', (v) => /^-?\d+(\.\d+)?$/.test(v)),
      Query: {
        serviceInfo: () => ({ backend: client.backend === 'live' ? 'LIVE' : 'SIMULATED', version: VERSION }),
        connectors: () =>
          client.connectors.map((c) => ({
            ...c,
            countries: c.countries.map((p) => ({
              ...p,
              sampleClearingCodes: Object.entries(p.sampleClearingCodes ?? {}).map(([label, code]) => ({ label, code })),
            })),
          })),
        ...roots,
      },
      Mutation: roots,
      BankQuery: {
        balance: wrap(({ session }: Ctx, args: Parameters<BankSession['getBalance']>[0]) => session.getBalance(args).then(deepCurrency)),
        statement: wrap(({ session }: Ctx, args: Parameters<BankSession['getStatement']>[0]) =>
          session.getStatement(args).then(deepCurrency),
        ),
        paymentStatus: wrap(({ session }: Ctx, args: Parameters<BankSession['getPaymentStatus']>[0]) =>
          session.getPaymentStatus(args).then(deepCurrency),
        ),
      },
      BankMutation: {
        initiatePayment: wrap(async ({ session }: Ctx, { input }: { input: Parameters<BankSession['initiatePayment']>[0] }) => {
          const r = await session.initiatePayment(input);
          const __typename = { SUBMITTED: 'PaymentSubmitted', REJECTED: 'PaymentRejected', OUTCOME_UNKNOWN: 'PaymentOutcomeUnknown' }[
            r.result
          ];
          return { ...r, __typename };
        }),
      },
      Statement: {
        openingBalance: (s: Statement) => s.balances.find((b) => b.type === 'OPENING_BOOKED') ?? null,
        closingBalance: (s: Statement) => s.balances.find((b) => b.type === 'CLOSING_BOOKED') ?? null,
        entries: (s: Statement, { creditDebit }: { creditDebit?: string }) =>
          creditDebit ? s.entries.filter((e) => e.creditDebit === creditDebit) : s.entries,
      },
      PaymentInfoStatus: {
        transactions: (p: PaymentInfoStatus, { state }: { state?: string }) =>
          state ? p.transactions.filter((t) => t.state === state) : p.transactions,
      },
      InitiatePaymentResult: { __resolveType: (r: { __typename: string }) => r.__typename },
    },
  });
}

export interface GraphQLHandlerOptions {
  client: BankClient;
  graphqlEndpoint?: string;
  graphiql?: boolean;
}

/** A web-standard (Request -> Response) GraphQL handler. Introspection is always enabled. */
export function createGraphQLHandler(o: GraphQLHandlerOptions): YogaServerInstance<Record<string, unknown>, Record<string, unknown>> {
  return createYoga({
    schema: createGraphQLSchema(o.client),
    graphqlEndpoint: o.graphqlEndpoint ?? '/graphql',
    graphiql: o.graphiql ?? o.client.backend === 'simulated',
    landingPage: false,
    maskedErrors: true,
  });
}
