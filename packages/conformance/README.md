# @iso20022-bank-kit/conformance

SPEC conformance suite for connector plugins. Each case names the requirement it verifies. It runs in simulated mode, so it works anywhere.

```ts
import { runConformance } from '@iso20022-bank-kit/conformance';
const results = await runConformance({ connector });
```

Part of [iso20022-bank-kit](../../README.md). Licensed under Apache-2.0.
