// Writes package.json and tsconfig.json for every workspace package from one table.
// Run after changing dependencies: node scripts/sync-packages.mjs
import { writeFileSync } from 'node:fs';

const VERSION = '0.1.0';
const ext = {
  zod: '^4.2.0',
  undici: '^7.16.0',
  graphql: '^17.0.0',
  'graphql-yoga': '^5.24.0',
  '@modelcontextprotocol/server': '^2.4.0',
  '@modelcontextprotocol/node': '^2.1.0',
  '@aws-sdk/client-secrets-manager': '^3.700.0',
};
const P = {
  iso20022: {
    desc: 'ISO 20022 domain model, codes, validators, and JSON message builders/parsers (pain.001, pain.002, camt.052/053/060, tsmt.038, admi.002/004).',
    deps: ['zod'],
  },
  'swift-mt': {
    desc: 'SWIFT MT940/MT942 parser and writer, normalised to the ISO 20022 statement model.',
    deps: ['@iso20022-bank-kit/iso20022'],
  },
  core: {
    desc: 'Connector plugin contract, bank client with the safety rules from SPEC.md, and shared OAuth2/mTLS HTTP transport.',
    deps: ['@iso20022-bank-kit/iso20022', 'undici'],
  },
  simulator: {
    desc: 'Deterministic simulated bank (ledger, payment lifecycle, failure scenarios) and a ready-made simulated connector.',
    deps: ['@iso20022-bank-kit/core', '@iso20022-bank-kit/iso20022'],
  },
  'connector-bac': {
    desc: 'Unofficial BAC Credomatic API Center 2.0 connector plugin (PA, CR, NI, HN, SV, GT).',
    deps: ['@iso20022-bank-kit/core', '@iso20022-bank-kit/iso20022', '@iso20022-bank-kit/swift-mt', '@iso20022-bank-kit/simulator'],
  },
  conformance: {
    desc: 'Conformance suite for connector plugins, traceable to SPEC.md requirements.',
    deps: ['@iso20022-bank-kit/core', '@iso20022-bank-kit/iso20022', '@iso20022-bank-kit/simulator'],
  },
  graphql: {
    desc: 'GraphQL API generated from the installed connector plugins.',
    deps: ['@iso20022-bank-kit/core', '@iso20022-bank-kit/iso20022', 'graphql', 'graphql-yoga'],
  },
  mcp: {
    desc: 'MCP server generated from the installed connector plugins.',
    deps: ['@iso20022-bank-kit/core', '@iso20022-bank-kit/iso20022', '@modelcontextprotocol/server', 'zod'],
  },
  cli: {
    desc: 'ibk command line: validate messages, convert MT940 to camt.053, check IBAN/BIC, build pain.001, serve GraphQL+MCP, run conformance.',
    deps: [
      '@iso20022-bank-kit/core',
      '@iso20022-bank-kit/iso20022',
      '@iso20022-bank-kit/swift-mt',
      '@iso20022-bank-kit/simulator',
      '@iso20022-bank-kit/connector-bac',
      '@iso20022-bank-kit/conformance',
      '@iso20022-bank-kit/graphql',
      '@iso20022-bank-kit/mcp',
      '@modelcontextprotocol/node',
      '@modelcontextprotocol/server',
    ],
    bin: { ibk: './dist/bin.js' },
  },
  lambda: {
    desc: 'AWS Lambda entry serving GraphQL and MCP.',
    deps: [
      '@iso20022-bank-kit/core',
      '@iso20022-bank-kit/connector-bac',
      '@iso20022-bank-kit/simulator',
      '@iso20022-bank-kit/graphql',
      '@iso20022-bank-kit/mcp',
      '@aws-sdk/client-secrets-manager',
    ],
    private: true,
  },
};

for (const [name, p] of Object.entries(P)) {
  const dir = `packages/${name}`;
  const local = p.deps.filter((d) => d.startsWith('@iso20022-bank-kit/'));
  const pkg = {
    name: `@iso20022-bank-kit/${name}`,
    version: VERSION,
    description: p.desc,
    license: 'Apache-2.0',
    type: 'module',
    ...(p.private ? { private: true } : {}),
    repository: { type: 'git', url: 'git+https://github.com/marrder/iso20022-bank-kit.git', directory: dir },
    engines: { node: '>=22' },
    sideEffects: false,
    // "source" lets tests and dev tools run the TypeScript directly: node --conditions=source --import tsx
    exports: { '.': { source: './src/index.ts', types: './dist/index.d.ts', import: './dist/index.js' } },
    ...(p.bin ? { bin: p.bin } : {}),
    files: ['dist', 'README.md'],
    dependencies: Object.fromEntries(p.deps.map((d) => [d, d.startsWith('@iso20022-bank-kit/') ? VERSION : ext[d]])),
    publishConfig: { access: 'public', provenance: true },
  };
  writeFileSync(`${dir}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(
    `${dir}/tsconfig.json`,
    `${JSON.stringify(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: { rootDir: 'src', outDir: 'dist', tsBuildInfoFile: 'dist/.tsbuildinfo' },
        include: ['src'],
        references: local.map((d) => ({ path: `../${d.split('/')[1]}` })),
      },
      null,
      2,
    )}\n`,
  );
}
console.log('synced', Object.keys(P).length, 'packages');
