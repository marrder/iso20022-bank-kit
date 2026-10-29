// Example connector plugin for a fictional bank, "Acme Bank".
//
// Load it into any host without changing the kit:
//   npm run ibk -- conformance --plugin ./examples/acme-connector/index.ts
//   npm run ibk -- serve --plugin ./examples/acme-connector/index.ts
//
// A real connector replaces `open()` with code that builds the bank's wire messages (see
// packages/connector-bac for a complete one). The kit supplies the rest: validation, outcome
// classification, GraphQL/MCP exposure, and the conformance suite.
import { assertAllowedUrl, type CountryProfile, createOAuthJsonClient, defineConnector } from '@iso20022-bank-kit/core';
import { createSimulatedConnector } from '@iso20022-bank-kit/simulator';

const countries: CountryProfile[] = [
  {
    code: 'CO',
    name: 'Colombia',
    bankBic: 'ACMECOBB',
    localCurrency: 'COP',
    requiresIban: false,
    intrabankClearingCode: '0999',
    utcOffsetMinutes: -300,
  },
  {
    code: 'DO',
    name: 'República Dominicana',
    bankBic: 'ACMEDOSD',
    localCurrency: 'DOP',
    requiresIban: true,
    intrabankClearingCode: '0998',
    utcOffsetMinutes: -240,
  },
];

// Simulated mode: reuse the generic simulated session. A real connector should instead run its own
// wire codec against the simulation engine (SPEC IBK-PLG-004), as connector-bac does.
const simulated = createSimulatedConnector({ id: 'acme', name: 'Acme Bank', countries });

export const acmeConnector = defineConnector({
  id: 'acme',
  name: 'Acme Bank',
  version: '0.1.0',
  description: 'Example connector for a fictional bank. Use it as a template.',
  countries,
  capabilities: {
    balance: true,
    statementFormats: ['CAMT053'],
    paymentInitiation: true,
    paymentStatus: true,
    routes: ['INTRABANK', 'DOMESTIC_CLEARING'],
  },
  connectionFields: [
    { key: 'endpoint', description: 'API base URL', default: 'https://api.acme-bank.example' },
    { key: 'clientId', description: 'OAuth2 client id', required: true },
    { key: 'clientSecret', description: 'OAuth2 client secret', required: true, secret: true },
  ],
  defaultAllowedHosts: ['api.acme-bank.example'],
  validatePayment: (batch) => (batch.transfers.length > 100 ? ['Acme accepts at most 100 transfers per batch'] : []),
  open(connection, ctx) {
    if (ctx.backend === 'simulated') return simulated.open(connection, ctx);
    const endpoint = connection.endpoint ?? 'https://api.acme-bank.example';
    assertAllowedUrl(endpoint, ctx.allowedHosts, 'connection.endpoint');
    const http = createOAuthJsonClient({
      baseUrl: endpoint,
      tokenUrl: `${endpoint}/oauth/token`,
      clientId: connection.clientId ?? '',
      clientSecret: connection.clientSecret ?? '',
      timeoutMs: ctx.timeoutMs,
    });
    const notImplemented = () =>
      Promise.reject(new Error(`Acme live API not implemented in this example (would POST via ${typeof http.post})`));
    return { getBalance: notImplemented, getStatement: notImplemented, getPaymentStatus: notImplemented, initiatePayment: notImplemented };
  },
});

export default acmeConnector;
