// Where connection values come from on each host, derived from the connector's field list.
import type { BankConnector, Connection, ConnectionField } from './connector.js';
import { ConnectionError } from './errors.js';

const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const kebab = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** e.g. bac + clientSecret -> BAC_CLIENT_SECRET */
export const envName = (connector: Pick<BankConnector, 'id'>, field: Pick<ConnectionField, 'key'>) =>
  `${connector.id.toUpperCase()}_${snake(field.key)}`;
/** e.g. bac + clientSecret -> x-bac-client-secret */
export const headerName = (connector: Pick<BankConnector, 'id'>, field: Pick<ConnectionField, 'key'>) =>
  `x-${connector.id}-${kebab(field.key)}`;

function collect(connector: BankConnector, get: (field: ConnectionField) => string | null | undefined): Connection | null {
  const conn: Record<string, string> = {};
  for (const f of connector.connectionFields) {
    const v = get(f);
    if (v) conn[f.key] = v;
  }
  return Object.keys(conn).length ? conn : null;
}

export const connectionFromEnv = (connector: BankConnector, env: Readonly<Record<string, string | undefined>>) =>
  collect(connector, (f) => env[envName(connector, f)]);
export const connectionFromHeaders = (connector: BankConnector, headers: Headers) =>
  collect(connector, (f) => headers.get(headerName(connector, f)));

/** Applies defaults and checks required fields; values outside `values` are rejected. */
export function resolveConnection(connector: BankConnector, input: Connection | null | undefined): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const missing: string[] = [];
  for (const f of connector.connectionFields) {
    const v = input?.[f.key] ?? f.default;
    if (v !== undefined && f.values && !f.values.includes(v))
      throw new ConnectionError(`connection.${f.key} must be one of ${f.values.join(', ')}`);
    if (f.required && !v) missing.push(f.key);
    out[f.key] = v;
  }
  if (missing.length) throw new ConnectionError(`${connector.name} connection is missing ${missing.join(', ')}`);
  return out;
}

/** Copy safe to log: secret fields replaced (SPEC IBK-SEC-003). */
export function redactConnection(connector: BankConnector, conn: Connection): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(conn).map(([k, v]) => [k, connector.connectionFields.find((f) => f.key === k)?.secret && v ? '***' : v]),
  );
}
