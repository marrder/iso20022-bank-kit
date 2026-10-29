// Runs the SPEC conformance suite against every built-in connector.

import { type ConformanceOptions, conformanceCases, createHarness, runConformance } from '@iso20022-bank-kit/conformance';
import { bacConnector } from '@iso20022-bank-kit/connector-bac';
import { createSimulatedConnector } from '@iso20022-bank-kit/simulator';
import { describe, expect, it } from 'vitest';

const targets: [string, ConformanceOptions][] = [
  ['bac (HN, account number)', { connector: bacConnector, country: 'HN' }],
  ['bac (CR, IBAN)', { connector: bacConnector, country: 'CR', account: { iban: 'CR41010200009998886660' } }],
  ['sim (US)', { connector: createSimulatedConnector(), country: 'US' }],
  ['sim (GB, IBAN)', { connector: createSimulatedConnector(), country: 'GB', account: { iban: 'GB52SIMB00000012345678' } }],
];

describe.each(targets)('%s', (_, options) => {
  it.each(conformanceCases.map((c) => [`${c.requirements.join(' ')} ${c.title}`, c] as const))('%s', async (_name, c) => {
    await c.run(createHarness(options));
  });
});

it('runConformance reports failures instead of throwing', async () => {
  const broken = { ...createSimulatedConnector(), countries: [] };
  const failed = await runConformance({ connector: broken });
  expect(failed.every((r) => !r.ok && /does not declare/.test(r.error ?? ''))).toBe(true);
  const results = await runConformance({ connector: createSimulatedConnector() });
  expect(results.every((r) => r.ok)).toBe(true);
});
