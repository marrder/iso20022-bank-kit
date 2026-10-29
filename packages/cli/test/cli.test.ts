import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Io, run } from '@iso20022-bank-kit/cli';
import { encodeMtFile } from '@iso20022-bank-kit/connector-bac';
import { sampleBatch } from '@iso20022-bank-kit/simulator';
import { describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'ibk-'));
const file = (name: string, content: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
};

async function ibk(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: {}, readFile: (p) => require('node:fs').readFileSync(p, 'utf8') };
  const code = await run(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const MT940 =
  '{1:F01SIMBUS33AXXX0000000000}{2:O9400000000000CLIENTXX0000000000000000000000N}{4:\r\n:20:R1\r\n:25:42\r\n:28C:0101/1\r\n:60F:C260101USD10,00\r\n:61:2601010101D4,50NTRFE2E\r\n:86:/x\r\n:62F:C260101USD5,50\r\n-}';

describe('ibk', () => {
  it('help', async () => {
    expect((await ibk('help')).out).toMatch(/ISO 20022 Bank Kit tools/);
    expect((await ibk('nope')).code).toBe(2);
  });
  it('iban / bic', async () => {
    expect(await ibk('iban', 'GB52SIMB00000012345678')).toMatchObject({ code: 0, out: '✓ valid IBAN (GB)' });
    expect((await ibk('iban', 'GB53SIMB00000012345678')).err).toMatch(/check digits are wrong/);
    expect((await ibk('iban', '--make', 'GB', 'SIMB00000012345678')).out).toBe('GB52SIMB00000012345678');
    expect((await ibk('bic', 'BMILHNTEXXX')).out).toMatch(/country HN/);
    expect((await ibk('bic', 'bad')).code).toBe(1);
  });
  it('build pain001 then validate it, with and without bank rules', async () => {
    const batch = file('batch.json', sampleBatch('HN', 'HNL', { messageId: 'CLI-1' }));
    const built = await ibk('build', 'pain001', batch);
    expect(built.code).toBe(0);
    expect(built.out).toContain('"PaymentInitiationServiceV03"');
    const pain = file('pain.json', built.out);
    expect(await ibk('validate', pain)).toMatchObject({ code: 0, out: '✓ pain.001.001.03 is valid' });
    const long = sampleBatch('HN', 'HNL');
    long.transfers[0] = { ...long.transfers[0]!, references: ['a'.repeat(30), 'b'.repeat(30)] };
    const longPain = file('long.json', (await ibk('build', 'pain001', file('long-batch.json', long))).out);
    expect((await ibk('validate', longPain)).code).toBe(0);
    const withRules = await ibk('validate', longPain, '--connector', 'bac');
    expect(withRules.code).toBe(1);
    expect(withRules.err).toMatch(/allows 35 at BAC/);
  });
  it('validate reports schema problems', async () => {
    const r = await ibk('validate', file('bad.json', { CstmrCdtTrfInitn: { GrpHdr: { MsgId: '' } } }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/pain\.001\.001\.03: \d+ problem/);
    expect((await ibk('validate', file('unknown.json', { foo: 1 }))).code).toBe(1);
  });
  it('mt: raw FIN or BAC F{base64} to statement JSON or camt.053', async () => {
    const json = JSON.parse((await ibk('mt', file('a.mt940', MT940))).out);
    expect(json.entries[0]).toMatchObject({ amount: '4.50', reference: 'E2E', transactionType: 'TRANSFER' });
    const camt = JSON.parse((await ibk('mt', file('b.json', { File: encodeMtFile(MT940) }), '--to', 'camt053')).out);
    expect(camt.BkToCstmrStmt.Stmt.Ntry[0]).toMatchObject({ NtryRef: 'E2E', CdtDbtInd: 'DBIT', BkTxCd: { Domn: { Cd: 'NTRF' } } });
  });
  it('schema writes one JSON Schema per message', async () => {
    const out = join(dir, 'schemas');
    expect((await ibk('schema', '--out', out)).code).toBe(0);
    expect(readdirSync(out)).toContain('pain.001.001.03.schema.json');
  });
  it('sdl and conformance', async () => {
    expect((await ibk('sdl')).out).toMatch(/input BacConnectionInput/);
    const c = await ibk('conformance', '--connector', 'bac', '--country', 'CR', '--iban', 'CR41010200009998886660');
    expect(c.code).toBe(0);
    expect(c.out).toMatch(/12\/12 passed/);
  });
});
