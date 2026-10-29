// OAuth2 client-credentials JSON transport with optional mTLS, shared by connectors.
// Implements SPEC IBK-SEC-002 (https + allowlist, no redirects) and IBK-AUTH-001 (one retry on 401).
import { randomUUID } from 'node:crypto';
import { Agent, fetch } from 'undici';
import { ConnectionError, TransportError } from './errors.js';

/** Throws unless `url` is https and its host matches the allowlist ("*.example.com" or exact). */
export function assertAllowedUrl(url: string, allowedHosts: readonly string[], label = 'endpoint'): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConnectionError(`${label} is not a valid URL`);
  }
  const host = u.hostname.toLowerCase();
  const ok =
    u.protocol === 'https:' && allowedHosts.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p.toLowerCase()));
  if (!ok) throw new ConnectionError(`${label} must be an https URL on an allowed host (${allowedHosts.join(', ') || 'none configured'})`);
}

export interface OAuthJsonClientOptions {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** BASIC_HEADER (default) or REQUEST_BODY. */
  tokenAuth?: 'BASIC_HEADER' | 'REQUEST_BODY';
  mtls?: { cert: string; key: string; ca?: string };
  timeoutMs: number;
  /** Extra headers on every API call (not the token call). */
  headers?: (traceId: string) => Record<string, string>;
}

export interface JsonResponse {
  status: number;
  body: unknown;
  traceId: string;
}

export interface OAuthJsonClient {
  post(path: string, body: unknown): Promise<JsonResponse>;
}

export function createOAuthJsonClient(o: OAuthJsonClientOptions): OAuthJsonClient {
  const dispatcher = o.mtls
    ? new Agent({ connect: { cert: o.mtls.cert, key: o.mtls.key, ...(o.mtls.ca ? { ca: o.mtls.ca } : {}) } })
    : undefined;
  let token: { value: string; expiresAt: number } | null = null;

  async function call(url: string, init: Parameters<typeof fetch>[1]) {
    try {
      return await fetch(url, { ...init, dispatcher, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs) });
    } catch (err) {
      const e = err as Error;
      const kind = e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
      throw new TransportError(kind, `${kind === 'TIMEOUT' ? 'Timed out' : 'Network error'} calling ${new URL(url).pathname}`);
    }
  }

  async function getToken(force: boolean): Promise<string> {
    if (!force && token && token.expiresAt > Date.now() + 60_000) return token.value;
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (o.scope) form.set('scope', o.scope);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (o.tokenAuth === 'REQUEST_BODY') {
      form.set('client_id', o.clientId);
      form.set('client_secret', o.clientSecret);
    } else {
      headers.authorization = `Basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')}`;
    }
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await call(o.tokenUrl, { method: 'POST', headers, body: form });
    } catch (e) {
      // The instruction itself was never sent.
      if (e instanceof TransportError) throw new TransportError(e.kind, e.message, { definitelyNotProcessed: true });
      throw e;
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) {
      throw new TransportError('AUTH', `Token request failed with HTTP ${res.status}`, {
        httpStatus: res.status,
        definitelyNotProcessed: true,
      });
    }
    token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 300) * 1000 };
    return token.value;
  }

  async function postOnce(path: string, body: unknown, accessToken: string): Promise<JsonResponse> {
    const traceId = randomUUID();
    const res = await call(o.baseUrl + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...o.headers?.(traceId),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    return { status: res.status, body: parsed, traceId };
  }

  return {
    async post(path, body) {
      const res = await postOnce(path, body, await getToken(false));
      // A rejected token is refused before processing, so one retry is safe even for payments.
      return res.status === 401 ? postOnce(path, body, await getToken(true)) : res;
    },
  };
}

/** Accepts PEM text or base64-encoded PEM. */
export function decodePem(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.includes('-----BEGIN') ? value : Buffer.from(value, 'base64').toString('utf8');
}
