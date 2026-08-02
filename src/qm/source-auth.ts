import { createHmac } from 'node:crypto';

export function canonicalPayload(method: string, pathWithQuery: string, body: string): string {
  return `${method}\n${pathWithQuery}\n${body}`;
}

export function signRequest(secret: string, timestampSec: number, canonical: string): string {
  const digest = createHmac('sha256', secret).update(`v0:${timestampSec}:${canonical}`).digest('hex');
  return `v0=${digest}`;
}

export function signedRequestHeaders(
  secret: string,
  method: string,
  pathWithQuery: string,
  body = '',
  base: Record<string, string> = {},
  nowSec: number = Math.floor(Date.now() / 1_000),
): Record<string, string> {
  const canonical = canonicalPayload(method, pathWithQuery, body);
  return {
    ...base,
    'x-timestamp': String(nowSec),
    'x-signature': signRequest(secret, nowSec, canonical),
  };
}
