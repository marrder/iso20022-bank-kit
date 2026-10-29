// Validators for ISO 20022 data types and identifiers.

/** ISO 13616 IBAN: format plus mod-97 check digits. */
export function isValidIban(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** ISO 13616 format only (country, 2 digits, 11-30 alphanumerics), without check digits. */
export function isWellFormedIban(value: string): boolean {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value.replace(/\s+/g, '').toUpperCase());
}

/** Builds a valid IBAN (correct check digits) from a country code and BBAN. Handy for test data. */
export function ibanFromBban(country: string, bban: string): string {
  const base = `${bban}${country.toUpperCase()}00`;
  let remainder = 0;
  for (const ch of base.toUpperCase()) {
    const digits = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return `${country.toUpperCase()}${String(98 - remainder).padStart(2, '0')}${bban}`;
}

export function ibanCountry(value: string): string | null {
  return isValidIban(value) ? value.replace(/\s+/g, '').slice(0, 2).toUpperCase() : null;
}

/** ISO 9362 BIC (8 or 11 characters). */
export function isValidBic(value: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(value);
}

/** Positive decimal with at most `fractionDigits` decimals (ISO ActiveOrHistoricCurrencyAndAmount). */
export function isValidAmount(value: string, fractionDigits = 2): boolean {
  if (!new RegExp(`^\\d{1,18}(\\.\\d{1,${fractionDigits}})?$`).test(value)) return false;
  return /[1-9]/.test(value);
}

/** Exact decimal sum (SPEC IBK-PAY-004). Inputs must be non-negative with at most `fractionDigits` decimals. */
export function sumAmounts(amounts: readonly string[], fractionDigits = 2): string {
  const scale = 10n ** BigInt(fractionDigits);
  let total = 0n;
  for (const a of amounts) {
    const [whole = '0', frac = ''] = a.split('.');
    total += BigInt(whole) * scale + BigInt((frac + '0'.repeat(fractionDigits)).slice(0, fractionDigits) || '0');
  }
  const frac = String(total % scale).padStart(fractionDigits, '0');
  return fractionDigits ? `${total / scale}.${frac}` : String(total);
}

export const MAX35 = 35;
export const MAX140 = 140;

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}
