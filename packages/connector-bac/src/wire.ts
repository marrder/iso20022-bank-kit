// BAC's JSON wire format: business messages wrapped in {"file": {"Envelope": {...}}} on requests and
// {"File": {"Envelope": {...}}} on responses; MT940/942 arrive as {"File": "F{<base64 FIN>}"}.
import type { BusinessMessage } from '@iso20022-bank-kit/iso20022';

export const wrap = (m: BusinessMessage) => ({ file: { Envelope: m } });

export interface Envelope {
  AppHdr?: { BizMsgIdr?: string; CreDt?: string; Fr?: { FIId?: { FinInstnId?: { BICFI?: string } } } };
  Document?: unknown;
}

export function unwrap(body: unknown): Envelope | null {
  const b = body as { File?: { Envelope?: Envelope }; file?: { Envelope?: Envelope } } | null;
  return b?.File?.Envelope ?? b?.file?.Envelope ?? null;
}

export function decodeMtFile(file: string): string {
  const m = /^F\{?([A-Za-z0-9+/=\s]+)\}?$/.exec(file.trim());
  if (!m?.[1]) throw new Error('Unrecognised MT payload; expected "F{<base64>}"');
  return Buffer.from(m[1], 'base64').toString('utf8');
}

export const encodeMtFile = (text: string) => `F{${Buffer.from(text, 'utf8').toString('base64')}`;
