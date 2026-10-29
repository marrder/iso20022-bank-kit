// The plugin contract. A bank connector is a plain object implementing BankConnector; hosts
// (SDK, GraphQL, MCP, CLI, Lambda) discover countries, capabilities and connection fields from it.
import type {
  AccountRef,
  BalanceReport,
  PaymentBatch,
  PaymentOutcome,
  PaymentStatusReport,
  Statement,
  StatementFormat,
  TransferRoute,
} from '@iso20022-bank-kit/iso20022';
import type { SimulationEngine } from './simulation.js';

export interface CountryProfile {
  /** ISO 3166-1 alpha-2 */
  code: string;
  name: string;
  /** BIC of the bank's entity in this country. */
  bankBic: string;
  localCurrency: string;
  requiresIban: boolean;
  /** Clearing member id of this bank, used for INTRABANK transfers. */
  intrabankClearingCode?: string;
  /** Example clearing codes for other banks (sandbox), keyed by label. */
  sampleClearingCodes?: Record<string, string>;
  /** Offset used for message timestamps. */
  utcOffsetMinutes: number;
}

export interface ConnectorCapabilities {
  balance: boolean;
  statementFormats: readonly StatementFormat[];
  paymentInitiation: boolean;
  paymentStatus: boolean;
  routes: readonly TransferRoute[];
  /**
   * 'enforce' (default) checks ISO 13616 check digits; 'format-only' checks the shape only, for banks
   * whose sandbox uses test IBANs with non-standard check digits.
   */
  ibanCheckDigits?: 'enforce' | 'format-only';
}

/** One credential/endpoint field. Hosts derive env var and header names from it. */
export interface ConnectionField {
  key: string;
  description: string;
  /** Never logged or echoed (SPEC IBK-SEC-003). */
  secret?: boolean;
  /** Must be present when the backend is live. */
  required?: boolean;
  /** Allowed values, exposed as an enum by GraphQL and MCP hosts. */
  values?: readonly string[];
  default?: string;
}

export type Connection = Readonly<Record<string, string | undefined>>;

export interface OpenContext {
  backend: 'live' | 'simulated';
  /** Present when backend is simulated. */
  simulation?: SimulationEngine;
  /** Hosts a live endpoint may use (SPEC IBK-SEC-002). */
  allowedHosts: readonly string[];
  timeoutMs: number;
  now: () => Date;
}

export interface BalanceRequest {
  country: string;
  account: AccountRef;
}

export interface StatementRequest {
  country: string;
  account: AccountRef;
  format: StatementFormat;
  fromDate: string;
  toDate?: string;
  fromTime?: string;
  toTime?: string;
}

export interface PaymentStatusRequest {
  country: string;
  messageId: string;
}

/** A connector bound to one set of credentials. */
export interface BankSession {
  getBalance(req: BalanceRequest): Promise<BalanceReport>;
  getStatement(req: StatementRequest): Promise<Statement>;
  getPaymentStatus(req: PaymentStatusRequest): Promise<PaymentStatusReport>;
  /**
   * Sends the batch exactly once. Implementations MUST NOT retry (SPEC IBK-PAY-001) and SHOULD
   * classify the response themselves; the client treats anything thrown as OUTCOME_UNKNOWN.
   */
  initiatePayment(batch: PaymentBatch): Promise<PaymentOutcome>;
}

export interface BankConnector {
  /** Lower-case identifier, e.g. "bac". Used in GraphQL field names, MCP args, env var prefixes. */
  id: string;
  name: string;
  version: string;
  /** Shown in docs and the GraphQL schema. */
  description: string;
  countries: readonly CountryProfile[];
  capabilities: ConnectorCapabilities;
  connectionFields: readonly ConnectionField[];
  /** Hosts this bank's live endpoints use; hosts add them to the allowlist unless overridden. */
  defaultAllowedHosts?: readonly string[];
  /** Bank-specific payment rules, checked after the generic ones. Return human-readable problems. */
  validatePayment?(batch: PaymentBatch): string[];
  open(connection: Connection, ctx: OpenContext): BankSession;
}

/** Identity helper that type-checks a connector definition. */
export function defineConnector<T extends BankConnector>(connector: T): T {
  if (!/^[a-z][a-z0-9]*$/.test(connector.id)) throw new TypeError(`Connector id "${connector.id}" must be lower-case alphanumeric`);
  return connector;
}
