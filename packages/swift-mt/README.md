# @iso20022-bank-kit/swift-mt

SWIFT MT940/MT942 parser and writer. `mtToStatement()` returns the same `Statement` shape as camt.053, so reconciliation code is written once.

```ts
import { mtToStatement } from '@iso20022-bank-kit/swift-mt';
const statement = mtToStatement(finText);
```

Part of [iso20022-bank-kit](../../README.md). Licensed under Apache-2.0.
