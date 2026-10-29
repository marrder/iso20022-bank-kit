// BAC Credomatic API Center 2.0: reference data and message conventions.
// Unofficial; not affiliated with or endorsed by BAC Credomatic.
import type { CountryProfile } from '@iso20022-bank-kit/core';
import { DEFAULT_PROFILE, type MessageProfile } from '@iso20022-bank-kit/iso20022';

export const BAC_COUNTRIES: readonly CountryProfile[] = [
  {
    code: 'PA',
    name: 'Panamá',
    bankBic: 'BCINPAPA',
    localCurrency: 'USD',
    requiresIban: false,
    intrabankClearingCode: '1384',
    sampleClearingCodes: { 'ACH (sandbox)': '1588' },
    utcOffsetMinutes: -300,
  },
  {
    code: 'CR',
    name: 'Costa Rica',
    bankBic: 'BSNJCRSJ',
    localCurrency: 'CRC',
    requiresIban: true,
    intrabankClearingCode: '102',
    sampleClearingCodes: { 'SINPE (sandbox)': '151' },
    utcOffsetMinutes: -360,
  },
  {
    code: 'NI',
    name: 'Nicaragua',
    bankBic: 'BAMCNIMA',
    localCurrency: 'NIO',
    requiresIban: false,
    intrabankClearingCode: '007',
    sampleClearingCodes: { 'ACH (sandbox)': '001' },
    utcOffsetMinutes: -360,
  },
  {
    code: 'HN',
    name: 'Honduras',
    bankBic: 'BMILHNTE',
    localCurrency: 'HNL',
    requiresIban: false,
    intrabankClearingCode: '024',
    sampleClearingCodes: { 'ACH (sandbox)': '001' },
    utcOffsetMinutes: -360,
  },
  {
    code: 'SV',
    name: 'El Salvador',
    bankBic: 'BAMCSVSS',
    localCurrency: 'USD',
    requiresIban: false,
    intrabankClearingCode: '025',
    sampleClearingCodes: { 'ACH (sandbox)': '001' },
    utcOffsetMinutes: -360,
  },
  {
    code: 'GT',
    name: 'Guatemala',
    bankBic: 'AMCNGTGT',
    localCurrency: 'GTQ',
    requiresIban: false,
    intrabankClearingCode: '042',
    sampleClearingCodes: { 'ACH (sandbox)': '101' },
    utcOffsetMinutes: -360,
  },
];

export const countryForBic = (bic: string | null | undefined) =>
  bic ? (BAC_COUNTRIES.find((c) => c.bankBic === bic.slice(0, 8))?.code ?? null) : null;
export const profileFor = (country: string) => {
  const p = BAC_COUNTRIES.find((c) => c.code === country);
  if (!p) throw new RangeError(`BAC does not serve ${country}`);
  return p;
};

export const BAC_MESSAGE_PROFILE: MessageProfile = {
  ...DEFAULT_PROFILE,
  msgDefIdr: { camt060: 'camt.060.001.05', tsmt038: 'TSMT.038.001.03', pain001: 'PaymentInitiationServiceV03' },
  reqdMsgNmId: { balance: 'AccountBalanceReportV08', CAMT053: 'camt.053.001.08', MT940: 'MT940', MT942: 'MT942' },
  currencyKey: '-Ccy',
  omitAccountTypeIn: ['CR'],
};

/** BAC Honduras reports lempiras as "LPS" in some messages. */
export const BAC_CURRENCY_ALIASES = { LPS: 'HNL' } as const;

export const ENVIRONMENTS = {
  SANDBOX: {
    baseUrl: 'https://api-dev2.baccredomatic.com:443/bac-latam-dev/development',
    tokenUrl: 'https://api-dev2.baccredomatic.com:443/bac-latam-dev/development/nop_bac-latam/oauth2/token',
  },
  /** Not published yet: pass endpoint and tokenUrl. */
  PRODUCTION: {},
} as const satisfies Record<string, { baseUrl?: string; tokenUrl?: string }>;

export const DEFAULT_ALLOWED_HOSTS = ['*.baccredomatic.com'] as const;

const STATEMENTS = '/v2/account-statement-apic-retrieve-account-statements';
export const PATHS = {
  initiatePayment: '/v2/payments-apic-payment-execution/transaction/initiate',
  paymentStatus: '/v2/payments-apic-payment-execution/transaction/retrieve',
  camt052: `${STATEMENTS}/accountbalancereport/CAMT052/retrieve`,
  camt053: `${STATEMENTS}/accountStatementService/camt053/retrieve`,
  mt940: `${STATEMENTS}/accountstatementmessage/MT940/retrieve`,
  mt942: `${STATEMENTS}/interimtransactionreport/MT942/retrieve`,
} as const;

export type BacOperation = keyof typeof PATHS;
