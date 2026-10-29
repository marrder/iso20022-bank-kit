// AWS Lambda entry: GraphQL at /graphql and MCP at /mcp, behind a Function URL or API Gateway
// (payload v1 or v2). Configuration:
//   BANK_BACKEND, BANK_ALLOWED_HOSTS, BANK_TIMEOUT_MS   see createClientFromEnv
//   BANK_CONNECTORS                                     built-ins to install (default "bac,sim")
//   BANK_CONNECTION_SECRET_ARN                          optional Secrets Manager secret, JSON { "<connectorId>": { field: value } },
//                                                       used when a request supplies no connection
//   MCP_ALLOWED_ORIGINS                                 browser origins allowed on /mcp
import { bacConnector } from '@iso20022-bank-kit/connector-bac';
import { type BankClient, type BankConnector, type Connection, createClientFromEnv } from '@iso20022-bank-kit/core';
import { createGraphQLHandler } from '@iso20022-bank-kit/graphql';
import { createMcpFetch } from '@iso20022-bank-kit/mcp';
import { createSimulatedConnector, simulationFor } from '@iso20022-bank-kit/simulator';

const BUILTINS: Record<string, () => BankConnector> = { bac: () => bacConnector, sim: () => createSimulatedConnector() };

interface LambdaEvent {
  rawPath?: string;
  path?: string;
  rawQueryString?: string;
  queryStringParameters?: Record<string, string> | null;
  headers?: Record<string, string | undefined> | null;
  requestContext?: { http?: { method?: string }; domainName?: string };
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
}

async function loadDefaultConnections(arn: string | undefined): Promise<Record<string, Connection> | undefined> {
  if (!arn) return undefined;
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const res = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(res.SecretString ?? '{}') as Record<string, Connection>;
}

export async function createApp(env: Readonly<Record<string, string | undefined>> = process.env) {
  const connectors = (env.BANK_CONNECTORS ?? 'bac,sim').split(',').map((id) => {
    const make = BUILTINS[id.trim()];
    if (!make) throw new Error(`Unknown connector ${id}`);
    return make();
  });
  const defaultConnections = await loadDefaultConnections(env.BANK_CONNECTION_SECRET_ARN);
  const client: BankClient = createClientFromEnv({
    env,
    connectors,
    simulation: () => simulationFor(connectors),
    ...(defaultConnections ? { defaultConnections } : {}),
  });
  const yoga = createGraphQLHandler({ client, graphiql: env.GRAPHIQL ? env.GRAPHIQL === 'true' : client.backend === 'simulated' });
  const mcp = createMcpFetch({ client, allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean) });
  return {
    client,
    fetch: (request: Request) => (new URL(request.url).pathname === '/mcp' ? mcp(request) : yoga.fetch(request)),
  };
}

let app: ReturnType<typeof createApp> | undefined;

export async function handler(event: LambdaEvent) {
  app ??= createApp();
  const { fetch } = await app;
  const path = event.rawPath ?? event.path ?? '/';
  const query = event.rawQueryString ?? new URLSearchParams(event.queryStringParameters ?? {}).toString();
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const host = headers.host ?? event.requestContext?.domainName ?? 'localhost';
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : undefined;
  const response = await fetch(
    new Request(`https://${host}${path}${query ? `?${query}` : ''}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
    }),
  );
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
    isBase64Encoded: false,
  };
}
