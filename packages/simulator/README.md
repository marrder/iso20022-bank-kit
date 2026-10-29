# @iso20022-bank-kit/simulator

Deterministic simulated bank (SPEC clause 11) with failure scenarios (`MOCK-500`, `MOCK-TIMEOUT`, `MOCK-503`, duplicates, `REJECT` creditors), a ready-made `sim` connector for building apps without a bank, and synthetic fixture factories.

```ts
import { createSimulatedConnector, simulationFor, sampleBatch } from '@iso20022-bank-kit/simulator';
```

Part of [iso20022-bank-kit](../../README.md). Licensed under Apache-2.0.
