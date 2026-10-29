// The Node SDK entry point. Wraps connector sessions with the rules in SPEC.md so every host
// (and every connector) behaves the same: capability checks, validation before transmission,
// and conservative payment outcome classification.
import type { PaymentBatch, PaymentOutcome } from '@iso20022-bank-kit/iso20022';
import { resolveConnection } from './connection.js';
import type {
  BalanceRequest,
  BankConnector,
  BankSession,
  Connection,
  OpenContext,
  PaymentStatusRequest,
  StatementRequest,
} from './connector.js';
import { BankError, TransportError, UnsupportedError, ValidationError } from './errors.js';
import type { SimulationEngine } from './simulation.js';
import { validateAccountRef, validatePaymentBatch } from './validation.js';

export const OUTCOME_UNKNOWN_GUIDANCE =
  'The bank did not confirm the outcome and the debit may have been applied. Query the payment status with this messageId and check the account statement before acting. Never resend with a different messageId.';

export interface BankClientOptions {
  connectors: readonly BankConnector[];
  /** Feature flag: simulated serves every request from `simulation`; live calls the banks. */
  backend: 'live' | 'simulated';
  simulation?: SimulationEngine;
  allowedHosts?: readonly string[];
  timeoutMs?: number;
  now?: () => Date;
  /** Used when a caller supplies no connection, e.g. loaded from a secrets store at startup. */
  defaultConnections?: Readonly<Record<string, Connection>>;
}

export interface BankClient {
  readonly backend: 'live' | 'simulated';
  readonly connectors: readonly BankConnector[];
  connector(id: string): BankConnector;
  /** Opens a session on one connector. In simulated mode `connection` may be omitted. */
  session(connectorId: string, connection?: Connection | null): BankSession;
}

export function createBankClient(options: BankClientOptions): BankClient {
  if (options.backend === 'simulated' && !options.simulation) throw new TypeError('backend "simulated" needs a simulation engine');
  const byId = new Map(options.connectors.map((c) => [c.id, c]));
  if (byId.size !== options.connectors.length) throw new TypeError('Connector ids must be unique');
  const ctx: OpenContext = {
    backend: options.backend,
    ...(options.simulation ? { simulation: options.simulation } : {}),
    allowedHosts: options.allowedHosts ?? [],
    timeoutMs: options.timeoutMs ?? 25_000,
    now: options.now ?? (() => new Date()),
  };

  function connector(id: string): BankConnector {
    const c = byId.get(id);
    if (!c) throw new UnsupportedError(`Unknown connector "${id}". Installed: ${[...byId.keys()].join(', ')}`);
    return c;
  }

  return {
    backend: options.backend,
    connectors: options.connectors,
    connector,
    session(connectorId, connection) {
      const c = connector(connectorId);
      const input = connection ?? options.defaultConnections?.[connectorId] ?? null;
      const conn = options.backend === 'live' ? resolveConnection(c, input) : { ...input };
      return guard(c, c.open(conn, ctx));
    },
  };
}

function requireCountry(c: BankConnector, country: string) {
  if (!c.countries.some((p) => p.code === country)) {
    throw new UnsupportedError(`${c.name} does not serve country ${country}. Supported: ${c.countries.map((p) => p.code).join(', ')}`);
  }
}

function checkAccount(c: BankConnector, req: BalanceRequest) {
  const problems: string[] = [];
  validateAccountRef(req.account, 'account', problems, c.capabilities.ibanCheckDigits ?? 'enforce');
  if (c.countries.find((p) => p.code === req.country)?.requiresIban && !req.account.iban)
    problems.push(`account: ${req.country} accounts must use iban`);
  if (problems.length) throw new ValidationError('Invalid account', problems);
}

/** Applies SPEC rules around a connector session. */
function guard(c: BankConnector, s: BankSession): BankSession {
  return {
    async getBalance(req) {
      if (!c.capabilities.balance) throw new UnsupportedError(`${c.name} does not support balance reports`);
      requireCountry(c, req.country);
      checkAccount(c, req);
      return s.getBalance(req);
    },
    async getStatement(req: StatementRequest) {
      if (!c.capabilities.statementFormats.includes(req.format)) {
        throw new UnsupportedError(`${c.name} does not support ${req.format}. Supported: ${c.capabilities.statementFormats.join(', ')}`);
      }
      requireCountry(c, req.country);
      checkAccount(c, req);
      const problems: string[] = [];
      if (req.toDate && req.toDate < req.fromDate) problems.push('toDate must not be before fromDate');
      if ((req.fromTime || req.toTime) && req.format !== 'MT942') problems.push('fromTime/toTime apply to MT942 only');
      if (problems.length) throw new ValidationError('Invalid statement request', problems);
      return s.getStatement(req);
    },
    async getPaymentStatus(req: PaymentStatusRequest) {
      if (!c.capabilities.paymentStatus) throw new UnsupportedError(`${c.name} does not support payment status`);
      requireCountry(c, req.country);
      return s.getPaymentStatus(req);
    },
    async initiatePayment(batch: PaymentBatch): Promise<PaymentOutcome> {
      if (!c.capabilities.paymentInitiation) throw new UnsupportedError(`${c.name} does not support payment initiation`);
      const problems = validatePaymentBatch(batch, c);
      if (problems.length) throw new ValidationError('Invalid payment batch', problems);
      try {
        return await s.initiatePayment(batch);
      } catch (e) {
        return classifyThrown(batch.messageId, e);
      }
    },
  };
}

/** Anything thrown after validation is treated as indeterminate unless provably not processed (SPEC IBK-PAY-002). */
export function classifyThrown(messageId: string, e: unknown): PaymentOutcome {
  if (e instanceof TransportError && e.details.definitelyNotProcessed) {
    return {
      result: 'REJECTED',
      messageId,
      category: 'UNAUTHORIZED',
      httpStatus: e.details.httpStatus ?? null,
      code: 'UNKNOWN',
      bankCode: null,
      description: e.message,
      duplicate: false,
    };
  }
  if (e instanceof BankError && e.details.httpStatus && e.details.httpStatus < 500) {
    return {
      result: 'REJECTED',
      messageId,
      category: e.category,
      httpStatus: e.details.httpStatus,
      code: e.details.bankErrorCode ?? 'UNKNOWN',
      bankCode: e.details.bankCode ?? null,
      description: e.message,
      duplicate: e.details.bankErrorCode === 'DUPLICATE_MESSAGE_ID',
    };
  }
  const category =
    e instanceof TransportError ? (e.kind === 'AUTH' ? 'UNAUTHORIZED' : e.kind) : e instanceof BankError ? e.category : 'INTERNAL_ERROR';
  const httpStatus = e instanceof BankError ? (e.details.httpStatus ?? null) : null;
  return {
    result: 'OUTCOME_UNKNOWN',
    messageId,
    category,
    httpStatus,
    detail: e instanceof Error ? e.message : String(e),
    guidance: OUTCOME_UNKNOWN_GUIDANCE,
  };
}

/** Classifies a bank HTTP response to a payment initiation (helper for connectors). */
export function classifyPaymentHttp(
  messageId: string,
  res: { status: number; reject?: { code: 'DUPLICATE_MESSAGE_ID' | 'UNKNOWN'; bankCode: string; description: string | null } | null },
  category: (status: number) => import('@iso20022-bank-kit/iso20022').ErrorCategory,
): PaymentOutcome | null {
  if (res.status >= 500) {
    return {
      result: 'OUTCOME_UNKNOWN',
      messageId,
      category: category(res.status),
      httpStatus: res.status,
      detail: res.reject?.description ?? null,
      guidance: OUTCOME_UNKNOWN_GUIDANCE,
    };
  }
  if (res.status >= 300 || res.reject) {
    return {
      result: 'REJECTED',
      messageId,
      category: category(res.status >= 300 ? res.status : 400),
      httpStatus: res.status,
      code: res.reject?.code ?? 'UNKNOWN',
      bankCode: res.reject?.bankCode ?? null,
      description: res.reject?.description ?? null,
      duplicate: res.reject?.code === 'DUPLICATE_MESSAGE_ID',
    };
  }
  return null;
}

export interface ClientFromEnvOptions {
  env: Readonly<Record<string, string | undefined>>;
  connectors: readonly BankConnector[];
  /** Called once when the backend is simulated. */
  simulation: () => SimulationEngine;
  defaultConnections?: Readonly<Record<string, Connection>>;
}

/**
 * Standard host configuration:
 *   BANK_BACKEND        simulated (default; "mock" accepted) | live
 *   BANK_ALLOWED_HOSTS  comma list; defaults to the connectors' defaultAllowedHosts
 *   BANK_TIMEOUT_MS     default 25000
 */
export function createClientFromEnv({ env, connectors, simulation, defaultConnections }: ClientFromEnvOptions): BankClient {
  const raw = (env.BANK_BACKEND ?? 'simulated').toLowerCase();
  const backend = raw === 'mock' || raw === 'simulated' ? 'simulated' : raw === 'live' ? 'live' : null;
  if (!backend) throw new TypeError(`BANK_BACKEND must be simulated or live (got "${env.BANK_BACKEND}")`);
  const allowedHosts = env.BANK_ALLOWED_HOSTS
    ? env.BANK_ALLOWED_HOSTS.split(',')
        .map((h) => h.trim())
        .filter(Boolean)
    : connectors.flatMap((c) => c.defaultAllowedHosts ?? []);
  return createBankClient({
    connectors,
    backend,
    ...(backend === 'simulated' ? { simulation: simulation() } : {}),
    allowedHosts,
    timeoutMs: Number(env.BANK_TIMEOUT_MS ?? 25_000),
    ...(defaultConnections ? { defaultConnections } : {}),
  });
}
