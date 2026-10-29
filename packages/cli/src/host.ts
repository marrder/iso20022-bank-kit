// Builds the connector set and serves GraphQL + MCP over node:http.
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bacConnector } from '@iso20022-bank-kit/connector-bac';
import { type BankClient, type BankConnector, createClientFromEnv } from '@iso20022-bank-kit/core';
import { createGraphQLHandler } from '@iso20022-bank-kit/graphql';
import { createMcpFetch } from '@iso20022-bank-kit/mcp';
import { createSimulatedConnector, simulationFor } from '@iso20022-bank-kit/simulator';
import { toWebRequest } from '@modelcontextprotocol/node';
import { hostHeaderValidationResponse, localhostAllowedHostnames } from '@modelcontextprotocol/server';

export const BUILTIN_CONNECTORS: Record<string, () => BankConnector> = {
  bac: () => bacConnector,
  sim: () => createSimulatedConnector(),
};

/** Loads a connector plugin module: its default export, or its first export that looks like a connector. */
export async function loadPlugin(specifier: string): Promise<BankConnector> {
  const url = specifier.startsWith('.') || specifier.startsWith('/') ? pathToFileURL(resolve(specifier)).href : specifier;
  const mod = (await import(url)) as Record<string, unknown>;
  const candidates = [mod.default, ...Object.values(mod)];
  const c = candidates.find(
    (x): x is BankConnector => typeof x === 'object' && x !== null && 'id' in x && 'open' in x && 'capabilities' in x,
  );
  if (!c) throw new Error(`${specifier} does not export a BankConnector`);
  return c;
}

export async function resolveConnectors(names: string | undefined, plugins: string[] = []): Promise<BankConnector[]> {
  const ids = (names ?? 'bac,sim')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = ids.map((id) => {
    const make = BUILTIN_CONNECTORS[id];
    if (!make)
      throw new Error(`Unknown connector "${id}". Built in: ${Object.keys(BUILTIN_CONNECTORS).join(', ')}; load others with --plugin`);
    return make();
  });
  for (const p of plugins) out.push(await loadPlugin(p));
  return out;
}

export function clientFor(connectors: BankConnector[], env: Readonly<Record<string, string | undefined>>): BankClient {
  return createClientFromEnv({ env, connectors, simulation: () => simulationFor(connectors) });
}

export function serve(client: BankClient, opts: { port: number; host?: string; log?: (s: string) => void }): Promise<Server> {
  const yoga = createGraphQLHandler({ client });
  const mcp = createMcpFetch({ client });
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) return yoga(req, res);
    const request = await toWebRequest(req);
    // Blocks DNS rebinding against a local server.
    const response = hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? (await mcp(request));
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((ok) =>
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      opts.log?.(`iso20022-bank-kit (${client.backend}; ${client.connectors.map((c) => c.id).join(', ')})`);
      opts.log?.(`  GraphQL  http://localhost:${port}/graphql`);
      opts.log?.(`  MCP      http://localhost:${port}/mcp`);
      ok(server);
    }),
  );
}
