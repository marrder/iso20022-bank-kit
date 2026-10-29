# Deploying with CloudFormation

`template.yaml` is plain CloudFormation, with no transform and no CDK. It creates:

| Resource                                      | Purpose                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `Function`                                    | Node 22 arm64 Lambda serving `/graphql` and `/mcp`                                     |
| `FunctionUrl`                                 | `AWS_IAM`-authenticated URL (SigV4), for GraphQL and SigV4-capable MCP clients         |
| `McpApi` + `McpAuthorizer` + route (optional) | HTTP API with a **JWT authorizer** in front of `POST /mcp`, for OAuth/OIDC MCP clients |
| `FunctionRole`                                | Logs, plus `secretsmanager:GetSecretValue` on one secret when configured               |
| `LogGroup`                                    | JSON logs with retention                                                               |
| `ErrorsAlarm`, `ThrottlesAlarm`               | Optional SNS notifications                                                             |

## Deploy

```sh
npm ci && npm run bundle:lambda            # -> packages/lambda/build/index.mjs
aws cloudformation package \
  --template-file deploy/cloudformation/template.yaml \
  --s3-bucket <artifact-bucket> \
  --output-template-file deploy/cloudformation/packaged.yaml
aws cloudformation deploy \
  --template-file deploy/cloudformation/packaged.yaml \
  --stack-name iso20022-bank-kit \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides BankBackend=simulated
```

## Going live

1. Store the default connection in Secrets Manager as JSON keyed by connector id:

   ```json
   { "bac": { "clientId": "…", "clientSecret": "…", "clientBic": "…", "ownerBic": "…" } }
   ```
2. Redeploy with `BankBackend=live ConnectionSecretArn=<arn> ReservedConcurrency=5`.
3. For MCP clients that use OAuth, set `McpJwtIssuer` and `McpJwtAudience`. For example, use a
   Cognito user pool issuer URL and an app client id.

Callers may still pass their own connection: a GraphQL `connection` argument or MCP `X-Bac-*` headers.
It overrides the default.

## Parameters

| Name                              | Default     | Notes                                  |
| --------------------------------- | ----------- | -------------------------------------- |
| `BankBackend`                     | `simulated` | Feature flag                           |
| `BankConnectors`                  | `bac,sim`   | Built-in connectors to install         |
| `BankAllowedHosts`                | (empty)     | Empty uses the connectors' defaults    |
| `ConnectionSecretArn`             | (empty)     | Default connections                    |
| `McpJwtIssuer` / `McpJwtAudience` | (empty)     | Enables the JWT-protected MCP endpoint |
| `McpAllowedOrigins`               | (empty)     | Browser origins allowed on `/mcp`      |
| `LogRetentionDays`                | 30          |                                        |
| `AlarmTopicArn`                   | (empty)     |                                        |
| `ReservedConcurrency`             | -1          | Caps the load on the bank              |

Validate the template with `cfn-lint deploy/cloudformation/template.yaml`. CI runs this check too.
