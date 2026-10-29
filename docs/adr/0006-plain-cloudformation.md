# ADR 0006 — One plain CloudFormation template (no SAM, no CDK)

- Status: accepted
- Date: 2026-10-28

## Decision

Deployment is a single `deploy/cloudformation/template.yaml` that uses only native resource types. The
Lambda code is a local path that `aws cloudformation package` uploads.

## Consequences

The template can be reviewed in one file, and it works in organisations that disallow transforms or
CDK bootstrapping. Features that SAM would generate (log group, URL, permissions, alarms) are written
out explicitly.
