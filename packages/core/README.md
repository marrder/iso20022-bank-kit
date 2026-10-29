# @iso20022-bank-kit/core

The Node SDK and the connector plugin contract. `createBankClient()` wraps every connector with the SPEC rules: capability checks, validation before transmission, and the three-outcome payment classification. Also includes the OAuth2/mTLS JSON transport for connector authors.

```ts
import { createBankClient } from '@iso20022-bank-kit/core';
```

Part of [iso20022-bank-kit](../../README.md). Licensed under Apache-2.0.
