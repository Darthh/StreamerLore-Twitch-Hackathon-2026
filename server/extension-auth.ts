import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export type ExtensionIdentity = {
  channelId: string;
  role: 'viewer' | 'moderator' | 'broadcaster';
  opaqueUserId: string;
  userId?: string;
};

export class ExtensionAuthError extends Error {
  status = 401;
  constructor() { super('Invalid or expired Twitch Extension token.'); }
}

const fail = (): never => { throw new ExtensionAuthError(); };
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value);
const clientId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9]{1,100}$/.test(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function decodePart(part: string, maxBytes: number): Buffer {
  if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) return fail();
  const decoded = Buffer.from(part, 'base64url');
  if (decoded.length > maxBytes || decoded.toString('base64url') !== part) return fail();
  return decoded;
}

function parseObject(part: string, maxBytes: number): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodePart(part, maxBytes))); }
  catch { return fail(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail();
  return parsed as Record<string, unknown>;
}

function decodeSecret(encoded: string): Buffer {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return fail();
  const secret = Buffer.from(encoded, 'base64');
  if (secret.length < 32 || secret.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return fail();
  return secret;
}

/** Verify the Helper JWT, never an EBS-created token with the `external` role. */
export function verifyExtensionToken(token: string, secretBase64: string, expectedClientId?: string): ExtensionIdentity {
  if (typeof token !== 'string' || !token || token.length > 12_288) return fail();
  if (expectedClientId !== undefined && !clientId(expectedClientId)) return fail();
  const parts = token.split('.');
  if (parts.length !== 3) return fail();
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = parseObject(headerPart, 2048);
  // No alternate algorithms, remote key resolution, or unsupported critical headers.
  if (header.alg !== 'HS256' || (header.typ !== undefined && header.typ !== 'JWT') ||
      header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined ||
      header.crit !== undefined || header.b64 !== undefined) return fail();
  const suppliedSignature = decodePart(signaturePart, 32);
  const expectedSignature = createHmac('sha256', decodeSecret(secretBase64)).update(`${headerPart}.${payloadPart}`).digest();
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) return fail();
  const claims = parseObject(payloadPart, 9216);
  const now = Math.floor(Date.now() / 1000);
  if (!timestamp(claims.exp) || claims.exp <= now) return fail();
  if (claims.nbf !== undefined && (!timestamp(claims.nbf) || claims.nbf > now + 30)) return fail();
  if (claims.iat !== undefined && (!timestamp(claims.iat) || claims.iat > now + 30 || claims.iat >= claims.exp)) return fail();
  if (!numericId(claims.channel_id)) return fail();
  if (typeof claims.opaque_user_id !== 'string' || !/^[UA][A-Za-z0-9_-]{1,127}$/.test(claims.opaque_user_id)) return fail();
  if (typeof claims.role !== 'string' || !['viewer', 'moderator', 'broadcaster'].includes(claims.role)) return fail();
  const role = claims.role as ExtensionIdentity['role'];
  if (role !== 'viewer' && !claims.opaque_user_id.startsWith('U')) return fail();
  if (claims.user_id !== undefined && !numericId(claims.user_id)) return fail();
  if (claims.opaque_user_id.startsWith('A') && claims.user_id !== undefined) return fail();
  if (role === 'broadcaster' && claims.user_id !== undefined && claims.user_id !== claims.channel_id) return fail();
  // Twitch does not require audience/client-ID claims in Helper JWTs.
  for (const claim of ['client_id', 'clientId']) {
    if (claims[claim] !== undefined && (!clientId(claims[claim]) || (expectedClientId && claims[claim] !== expectedClientId))) return fail();
  }
  if (claims.aud !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.length || audiences.length > 8 || !audiences.every(clientId) || (expectedClientId && !audiences.includes(expectedClientId))) return fail();
  }
  return {
    channelId: claims.channel_id,
    role,
    opaqueUserId: claims.opaque_user_id,
    ...(claims.user_id === undefined ? {} : { userId: claims.user_id as string }),
  };
}

/** Accept one explicit token header; return null only when no token was supplied. */
export function getExtensionIdentity(request: { headers: IncomingHttpHeaders }, secretBase64: string, expectedClientId?: string): ExtensionIdentity | null {
  const authorization = request.headers.authorization;
  const custom = request.headers['x-extension-jwt'];
  if (authorization === undefined && custom === undefined) return null;
  if (authorization !== undefined && custom !== undefined) return fail();
  let token: string;
  if (authorization !== undefined) {
    if (typeof authorization !== 'string' || authorization.length > 12_300) return fail();
    const match = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(authorization);
    if (!match) return fail();
    token = match[1];
  } else {
    if (typeof custom !== 'string') return fail();
    token = custom;
  }
  return verifyExtensionToken(token, secretBase64, expectedClientId);
}
