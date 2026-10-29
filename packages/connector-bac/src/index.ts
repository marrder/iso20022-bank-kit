// BAC Credomatic connector plugin. Unofficial; not affiliated with or endorsed by BAC Credomatic.

import type { BankConnector } from '@iso20022-bank-kit/core';
import { assertAllowedUrl, ConnectionError, createOAuthJsonClient, decodePem, defineConnector } from '@iso20022-bank-kit/core';
import type { PaymentBatch } from '@iso20022-bank-kit/iso20022';
import { BAC_COUNTRIES, DEFAULT_ALLOWED_HOSTS, ENVIRONMENTS, PATHS } from './profile.js';
import { type BacTransport, createBacSession } from './session.js';
import { createBacSimulatedTransport } from './simulated.js';

export * from './profile.js';
export { type BacTransport, createBacSession } from './session.js';
export { createBacSimulatedTransport } from './simulated.js';
export { decodeMtFile, encodeMtFile, unwrap, wrap } from './wire.js';

/** BAC-specific payment rules (from the API Center 2.0 onboarding notes). */
export function validateBacPayment(batch: PaymentBatch): string[] {
  const p: string[] = [];
  batch.transfers.forEach((t, i) => {
    const at = `transfers[${i}]`;
    const total = (t.references ?? []).reduce((n, r) => n + r.length, 0);
    const limit = t.route === 'CROSS_BORDER' ? 140 : 35;
    if (total > limit) p.push(`${at}.references total ${total} characters; ${t.route} allows ${limit} at BAC`);
    if (t.purposeCode && batch.country !== 'SV') p.push(`${at}.purposeCode applies to El Salvador only at BAC`);
  });
  return p;
}

export const bacConnector: BankConnector = defineConnector({
  id: 'bac',
  name: 'BAC Credomatic',
  version: '0.1.0',
  description:
    'BAC Credomatic API Center 2.0 (unofficial connector): balances, statements (camt.053, MT940, MT942), payments (pain.001) and tracking (pain.002) in Panamá, Costa Rica, Nicaragua, Honduras, El Salvador and Guatemala.',
  countries: BAC_COUNTRIES,
  capabilities: {
    balance: true,
    statementFormats: ['CAMT053', 'MT940', 'MT942'],
    paymentInitiation: true,
    paymentStatus: true,
    routes: ['INTRABANK', 'DOMESTIC_CLEARING', 'CROSS_BORDER'],
    // BAC sandbox examples use IBANs whose check digits do not validate.
    ibanCheckDigits: 'format-only',
  },
  connectionFields: [
    { key: 'environment', description: 'API Center environment', values: ['SANDBOX', 'PRODUCTION'], default: 'SANDBOX' },
    { key: 'endpoint', description: 'Base URL override; must be on the allowed hosts' },
    { key: 'tokenUrl', description: 'OAuth2 token URL override; must be on the allowed hosts' },
    { key: 'clientId', description: 'OAuth2 client id (also sent as the client-id header)', required: true },
    { key: 'clientSecret', description: 'OAuth2 client secret', secret: true, required: true },
    { key: 'scope', description: 'OAuth2 scope', default: 'tcd' },
    {
      key: 'tokenAuth',
      description: 'How client credentials are sent to the token endpoint',
      values: ['BASIC_HEADER', 'REQUEST_BODY'],
      default: 'BASIC_HEADER',
    },
    { key: 'clientBic', description: 'BIC/alias BAC assigned to your application (AppHdr.Fr)', required: true },
    { key: 'ownerBic', description: 'BIC/alias of the account-owning company', required: true },
    { key: 'mtlsCertificate', description: 'Client certificate PEM (or base64 PEM), if mTLS is required', secret: true },
    { key: 'mtlsPrivateKey', description: 'Client private key PEM (or base64 PEM)', secret: true },
    { key: 'mtlsCaCertificate', description: 'CA bundle PEM (or base64 PEM) for the BAC server certificate' },
  ],
  defaultAllowedHosts: DEFAULT_ALLOWED_HOSTS,
  validatePayment: validateBacPayment,
  open(conn, ctx) {
    if (ctx.backend === 'simulated') {
      if (!ctx.simulation) throw new TypeError('simulated backend without a simulation engine');
      return createBacSession(
        createBacSimulatedTransport(ctx.simulation),
        { clientBic: conn.clientBic ?? 'DUMMYMASTER', ownerBic: conn.ownerBic ?? 'DUMMYORDENA' },
        ctx.now,
      );
    }
    const env = ENVIRONMENTS[(conn.environment ?? 'SANDBOX') as keyof typeof ENVIRONMENTS] as { baseUrl?: string; tokenUrl?: string };
    const baseUrl = conn.endpoint?.replace(/\/+$/, '') ?? env.baseUrl;
    const tokenUrl = conn.tokenUrl ?? env.tokenUrl;
    if (!baseUrl || !tokenUrl) throw new ConnectionError(`BAC ${conn.environment} needs endpoint and tokenUrl`);
    assertAllowedUrl(baseUrl, ctx.allowedHosts, 'connection.endpoint');
    assertAllowedUrl(tokenUrl, ctx.allowedHosts, 'connection.tokenUrl');
    const cert = decodePem(conn.mtlsCertificate);
    const key = decodePem(conn.mtlsPrivateKey);
    if (Boolean(cert) !== Boolean(key)) throw new ConnectionError('mtlsCertificate and mtlsPrivateKey must be provided together');
    const ca = decodePem(conn.mtlsCaCertificate);
    const http = createOAuthJsonClient({
      baseUrl,
      tokenUrl,
      clientId: conn.clientId ?? '',
      clientSecret: conn.clientSecret ?? '',
      ...(conn.scope ? { scope: conn.scope } : {}),
      tokenAuth: conn.tokenAuth === 'REQUEST_BODY' ? 'REQUEST_BODY' : 'BASIC_HEADER',
      ...(cert && key ? { mtls: { cert, key, ...(ca ? { ca } : {}) } } : {}),
      timeoutMs: ctx.timeoutMs,
      headers: (traceId) => ({ 'client-id': conn.clientId ?? '', 'trace-id': traceId }),
    });
    const transport: BacTransport = { post: (op, body) => http.post(PATHS[op], body) };
    return createBacSession(transport, { clientBic: conn.clientBic ?? '', ownerBic: conn.ownerBic ?? '' }, ctx.now);
  },
});

export default bacConnector;
