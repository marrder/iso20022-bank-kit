// SWIFT MT940 (customer statement) and MT942 (interim transaction report): parse, write, and
// normalise to the ISO 20022 Statement model, so MT and camt.053 consumers share one shape (SPEC IBK-STM-001).

import type { Statement, StatementFormat } from '@iso20022-bank-kit/iso20022';
import { BalanceTypeCodes, CreditDebitCodes, normalizeCurrency, transactionType } from '@iso20022-bank-kit/iso20022';

export interface MtBalance {
  type: 'OPBD' | 'CLBD' | 'CLAV' | 'FWAV';
  creditDebit: 'CRDT' | 'DBIT';
  date: string;
  currency: string;
  amount: string;
}

export interface MtEntry {
  valueDate: string;
  bookingDate: string;
  creditDebit: 'CRDT' | 'DBIT';
  reversal: boolean;
  amount: string;
  /** 3-character transaction type identification code, e.g. TRF. */
  transactionType: string;
  reference: string | null;
  bankReference: string | null;
  description: string | null;
}

export interface MtSummary {
  count: number;
  currency: string;
  amount: string;
}

export interface MtMessage {
  messageType: 'MT940' | 'MT942' | null;
  senderBic: string | null;
  transactionReference: string | null;
  account: string | null;
  sequence: string | null;
  balances: MtBalance[];
  entries: MtEntry[];
  floorLimit: { currency: string; amount: string } | null;
  reportDateTime: string | null;
  debitSummary: MtSummary | null;
  creditSummary: MtSummary | null;
  information: string | null;
}

/** Splits block 4 into [tag, value] pairs; continuation lines join the previous value. */
function fields(text: string): [string, string][] {
  const start = text.indexOf('{4:');
  const body = (start >= 0 ? text.slice(start + 3) : text).replace(/-?\}\s*$/, '');
  const out: [string, string][] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out.push([m[1], m[2]]);
    else if (out.length && line.trim()) {
      const last = out[out.length - 1];
      if (last) last[1] += `\n${line}`;
    }
  }
  return out;
}

const amount = (s: string) => {
  const [w = '0', f = ''] = s.split(',');
  return `${w || '0'}.${(`${f}00`).slice(0, Math.max(2, f.length))}`;
};
const date6 = (s: string) => `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;

function balance(type: MtBalance['type'], value: string): MtBalance | null {
  const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)$/.exec(value.trim());
  if (!m?.[1] || !m[2] || !m[3] || !m[4]) return null;
  return { type, creditDebit: m[1] === 'C' ? 'CRDT' : 'DBIT', date: date6(m[2]), currency: m[3], amount: amount(m[4]) };
}

/** :61: YYMMDD[MMDD](C|D|RC|RD)[funds code]amount(N|S|F)code reference[//bank ref][\n details] */
function statementLine(value: string): MtEntry | null {
  const [first = '', ...rest] = value.split('\n');
  const m = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([\d,]+)([NSF])([A-Z0-9]{3})(.*?)(?:\/\/(.*))?$/.exec(first);
  if (!m?.[1] || !m[3] || !m[5] || !m[7]) return null;
  const [, valueDate, entryMmdd, mark, , amt, , type, reference = '', bankReference] = m;
  return {
    valueDate: date6(valueDate),
    bookingDate: entryMmdd ? `20${valueDate.slice(0, 2)}-${entryMmdd.slice(0, 2)}-${entryMmdd.slice(2)}` : date6(valueDate),
    creditDebit: mark.endsWith('C') ? 'CRDT' : 'DBIT',
    reversal: mark.startsWith('R'),
    amount: amount(amt),
    transactionType: type,
    reference: reference.trim() || null,
    bankReference: bankReference?.trim() || rest.join(' ').trim() || null,
    description: null,
  };
}

export function parseMt(text: string): MtMessage {
  const header = /\{2:O(\d{3})/.exec(text);
  const sender = /\{1:F01([A-Z0-9]{8})/.exec(text);
  const result: MtMessage = {
    messageType: header?.[1] === '940' ? 'MT940' : header?.[1] === '942' ? 'MT942' : null,
    senderBic: sender?.[1] ?? null,
    transactionReference: null,
    account: null,
    sequence: null,
    balances: [],
    entries: [],
    floorLimit: null,
    reportDateTime: null,
    debitSummary: null,
    creditSummary: null,
    information: null,
  };
  const balanceTags: Record<string, MtBalance['type']> = {
    '60F': 'OPBD',
    '60M': 'OPBD',
    '62F': 'CLBD',
    '62M': 'CLBD',
    '64': 'CLAV',
    '65': 'FWAV',
  };
  let last: MtEntry | null = null;
  for (const [tag, value] of fields(text)) {
    const balanceType = balanceTags[tag];
    if (tag === '86') {
      const info = value.replace(/^\//, '').replace(/\n/g, ' ').trim();
      // :86: right after :61: describes that entry; anywhere else it is statement-level.
      if (last && !last.description) last.description = info;
      else result.information = info;
      continue;
    }
    if (tag === '20') result.transactionReference = value.trim();
    else if (tag === '25') result.account = value.trim();
    else if (tag === '28C') result.sequence = value.trim();
    else if (balanceType) {
      const b = balance(balanceType, value);
      if (b) result.balances.push(b);
    } else if (tag === '61') {
      last = statementLine(value);
      if (last) result.entries.push(last);
      continue;
    } else if (tag === '34F') {
      const m = /^([A-Z]{3})([CD])?([\d,]+)$/.exec(value.trim());
      if (m?.[1] && m[3]) result.floorLimit = { currency: m[1], amount: amount(m[3]) };
    } else if (tag === '13D') {
      const m = /^(\d{6})(\d{2})(\d{2})([+-]\d{4})?$/.exec(value.trim());
      if (m?.[1]) result.reportDateTime = `${date6(m[1])}T${m[2]}:${m[3]}:00${m[4] ? `${m[4].slice(0, 3)}:${m[4].slice(3)}` : ''}`;
    } else if (tag === '90D' || tag === '90C') {
      const m = /^(\d+)([A-Z]{3})([\d,]+)$/.exec(value.trim());
      if (m?.[1] && m[2] && m[3])
        result[tag === '90D' ? 'debitSummary' : 'creditSummary'] = { count: Number(m[1]), currency: m[2], amount: amount(m[3]) };
    }
    last = null;
  }
  return result;
}

export interface ToStatementOptions {
  currencyAliases?: Readonly<Record<string, string>>;
  country?: string | null;
}

/** Normalises a parsed MT940/MT942 into the same Statement shape camt.053 produces. */
export function mtToStatement(text: string, options: ToStatementOptions = {}): Statement {
  const mt = parseMt(text);
  const format: StatementFormat = mt.messageType === 'MT942' ? 'MT942' : 'MT940';
  const aliases = options.currencyAliases;
  const ccy = normalizeCurrency(mt.balances[0]?.currency ?? mt.floorLimit?.currency ?? mt.debitSummary?.currency, aliases);
  const isIban = /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(mt.account ?? '');
  const summary = (s: MtSummary | null) => s && { count: s.count, amount: s.amount, currency: normalizeCurrency(s.currency, aliases) };
  return {
    format,
    country: options.country ?? null,
    bankMessageId: mt.transactionReference,
    statementId: mt.transactionReference,
    sequenceNumber: mt.sequence,
    page: Number(mt.sequence?.split('/')[1] ?? 1),
    lastPage: true,
    createdAt: mt.reportDateTime,
    fromDateTime: null,
    toDateTime: null,
    account: { number: isIban ? null : mt.account, iban: isIban ? mt.account : null, currency: ccy },
    balances: mt.balances.map((b) => ({
      type: BalanceTypeCodes.toDomain(b.type),
      typeCode: b.type,
      creditDebit: CreditDebitCodes.toDomain(b.creditDebit),
      amount: b.amount,
      currency: normalizeCurrency(b.currency, aliases),
      date: b.date,
      dateTime: null,
    })),
    entries: mt.entries.map((e) => ({
      reference: e.reference,
      bankReference: e.bankReference,
      endToEndId: null,
      creditDebit: CreditDebitCodes.toDomain(e.creditDebit),
      reversal: e.reversal,
      status: 'BOOKED',
      statusCode: null,
      bookingDate: e.bookingDate,
      valueDate: e.valueDate,
      transactionType: transactionType(e.transactionType),
      transactionTypeCode: e.transactionType,
      description: e.description,
      amount: e.amount,
      currency: ccy,
    })),
    interim:
      format === 'MT942'
        ? {
            floorLimit: mt.floorLimit && { amount: mt.floorLimit.amount, currency: normalizeCurrency(mt.floorLimit.currency, aliases) },
            debits: summary(mt.debitSummary),
            credits: summary(mt.creditSummary),
          }
        : null,
    information: mt.information,
    raw: text,
  };
}

const yymmdd = (iso: string) => iso.slice(2, 10).replaceAll('-', '');
const mtAmount = (a: string) => a.replace('.', ',');

export interface WriteMtInput {
  messageType: 'MT940' | 'MT942';
  senderBic: string;
  receiverBic: string;
  transactionReference: string;
  account: string;
  sequence: string;
  currency: string;
  opening?: { creditDebit: 'CRDT' | 'DBIT'; date: string; amount: string };
  closing?: { creditDebit: 'CRDT' | 'DBIT'; date: string; amount: string };
  available?: { creditDebit: 'CRDT' | 'DBIT'; date: string; amount: string };
  entries: {
    valueDate: string;
    bookingDate: string;
    creditDebit: 'CRDT' | 'DBIT';
    amount: string;
    transactionType: string;
    reference?: string | null;
    description?: string | null;
  }[];
  floorLimit?: string;
  /** MT942 :13D: as YYYY-MM-DDTHH:MM */
  reportDateTime?: string;
  information?: string;
}

/** Writes an MT940/MT942 FIN message. Inverse of parseMt for the fields it covers. */
export function writeMt(m: WriteMtInput): string {
  const lines = [
    `{1:F01${m.senderBic.padEnd(8, 'X').slice(0, 8)}AXXX0000000000}{2:O${m.messageType.slice(2)}0000000000${m.receiverBic}0000000000000000000000N}{4:`,
  ];
  lines.push(`:20:${m.transactionReference}`, `:25:${m.account}`, `:28C:${m.sequence}`);
  const bal = (tag: string, b?: WriteMtInput['opening']) => {
    if (b) lines.push(`:${tag}:${b.creditDebit === 'CRDT' ? 'C' : 'D'}${yymmdd(b.date)}${m.currency}${mtAmount(b.amount)}`);
  };
  if (m.messageType === 'MT942') {
    lines.push(`:34F:${m.currency}D${mtAmount(m.floorLimit ?? '0.00')}`);
    const dt = m.reportDateTime ?? new Date().toISOString();
    lines.push(`:13D:${yymmdd(dt)}${dt.slice(11, 13)}${dt.slice(14, 16)}`);
  } else bal('60F', m.opening);
  for (const e of m.entries) {
    lines.push(
      `:61:${yymmdd(e.valueDate)}${e.bookingDate.slice(5, 7)}${e.bookingDate.slice(8, 10)}${e.creditDebit === 'CRDT' ? 'C' : 'D'}${mtAmount(e.amount)}N${e.transactionType}${e.reference ?? 'NONREF'}`,
    );
    if (e.description) lines.push(`:86:/${e.description}`);
  }
  if (m.messageType === 'MT942') {
    for (const [tag, side] of [
      ['90D', 'DBIT'],
      ['90C', 'CRDT'],
    ] as const) {
      const xs = m.entries.filter((e) => e.creditDebit === side);
      const cents = xs.reduce((n, e) => n + Math.round(Number(e.amount) * 100), 0);
      lines.push(`:${tag}:${xs.length}${m.currency}${mtAmount((cents / 100).toFixed(2))}`);
    }
  } else {
    bal('62F', m.closing);
    bal('64', m.available);
  }
  if (m.information) lines.push(`:86:${m.information}`);
  return lines.join('\r\n') + (m.messageType === 'MT942' ? '}' : '\r\n-}');
}
