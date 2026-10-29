import type { BankErrorCode, ErrorCategory } from '@iso20022-bank-kit/iso20022';

/** Base class: every error this kit raises carries a machine-readable `code`. */
export class KitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input breaks the generic or the connector's rules. Nothing was sent (SPEC IBK-PAY-005). */
export class ValidationError extends KitError {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super('BAD_USER_INPUT', message);
  }
}

/** The connection (credentials, endpoint) is missing or not allowed. */
export class ConnectionError extends KitError {
  constructor(message: string) {
    super('BAD_CONNECTION', message);
  }
}

/** The connector does not support this operation, format or country. */
export class UnsupportedError extends KitError {
  constructor(message: string) {
    super('UNSUPPORTED', message);
  }
}

/** The bank answered with a rejection (non-2xx or an admi.002). */
export class BankError extends KitError {
  constructor(
    readonly category: ErrorCategory,
    message: string,
    readonly details: {
      httpStatus?: number | null;
      bankCode?: string | null;
      bankErrorCode?: BankErrorCode | null;
      traceId?: string | null;
    } = {},
  ) {
    super(category, message);
  }
}

export type TransportFailure = 'TIMEOUT' | 'NETWORK' | 'AUTH';

/**
 * No usable HTTP response. `definitelyNotProcessed` is true only when the bank provably did not
 * receive the instruction (e.g. the OAuth token request failed before it was sent).
 */
export class TransportError extends KitError {
  constructor(
    readonly kind: TransportFailure,
    message: string,
    readonly details: { httpStatus?: number | null; definitelyNotProcessed?: boolean } = {},
  ) {
    super(kind === 'AUTH' ? 'UNAUTHORIZED' : kind, message);
  }
}
