import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { ExtensionAuthError, getExtensionIdentity, verifyExtensionToken } from '../server/extension-auth.ts';

const key = randomBytes(32);
const secret = key.toString('base64');
const expectedClient = 'streamloreclient123';
const baseClaims = () => ({ exp: Math.floor(Date.now() / 1000) + 300, channel_id: '12345678', opaque_user_id: 'UstableViewer123', role: 'viewer' });
function signed(claims: unknown = baseClaims(), header: unknown = { alg: 'HS256', typ: 'JWT' }, signingKey = key): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${h}.${p}.${createHmac('sha256', signingKey).update(`${h}.${p}`).digest('base64url')}`;
}
function invalid(token: string, encodedSecret = secret) {
  assert.throws(() => verifyExtensionToken(token, encodedSecret, expectedClient), error => error instanceof ExtensionAuthError && error.status === 401 && error.message === 'Invalid or expired Twitch Extension token.');
}

test('Extension Helper identity accepts signed viewer, moderator, and broadcaster roles without optional identity claims', () => {
  for (const role of ['viewer', 'moderator', 'broadcaster'] as const) {
    const claims = { ...baseClaims(), role };
    assert.deepEqual(verifyExtensionToken(signed(claims), secret, expectedClient), { channelId: '12345678', role, opaqueUserId: claims.opaque_user_id });
  }
  assert.equal(verifyExtensionToken(signed({ ...baseClaims(), user_id: '7654321' }), secret).userId, '7654321');
  assert.equal(verifyExtensionToken(signed(baseClaims(), { alg: 'HS256' }), secret).role, 'viewer');
});

test('anonymous identities can be verified for viewing but cannot claim moderator privileges or linked identity', () => {
  const anonymous = { ...baseClaims(), opaque_user_id: 'AanonymousSession' };
  assert.equal(verifyExtensionToken(signed(anonymous), secret).opaqueUserId, anonymous.opaque_user_id);
  invalid(signed({ ...anonymous, role: 'moderator' }));
  invalid(signed({ ...anonymous, role: 'broadcaster' }));
  invalid(signed({ ...anonymous, user_id: '12345' }));
});

test('forged payloads, wrong shared secrets, and malformed signatures cannot authenticate', () => {
  const token = signed();
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...baseClaims(), role: 'broadcaster' })).toString('base64url');
  invalid(parts.join('.'));
  invalid(signed(baseClaims(), undefined, randomBytes(32)));
  invalid(`${token.split('.').slice(0, 2).join('.')}.AA`);
  invalid(`${token}=`);
  invalid(`${token}.extra`);
});

test('algorithm confusion, unsigned JWTs, remote keys, and critical header extensions are rejected', () => {
  for (const header of [
    { alg: 'none' }, { alg: 'HS384' }, { alg: 'RS256' }, { alg: 'hs256' }, { alg: 'HS256', typ: 'JWE' },
    { alg: 'HS256', jku: 'https://attacker.example/key' }, { alg: 'HS256', jwk: { kty: 'oct' } },
    { alg: 'HS256', x5u: 'https://attacker.example/certificate' }, { alg: 'HS256', crit: ['custom'] }, { alg: 'HS256', b64: false },
  ]) invalid(signed(baseClaims(), header));
  invalid(`${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(baseClaims())).toString('base64url')}.`);
});

test('expired, noninteger, and excessively future timestamps are rejected', () => {
  const now = Math.floor(Date.now() / 1000);
  for (const exp of [now, now - 1, '9999999999', 1.5, null, -1]) invalid(signed({ ...baseClaims(), exp }));
  invalid(signed({ ...baseClaims(), nbf: now + 120 }));
  invalid(signed({ ...baseClaims(), iat: now + 120 }));
  invalid(signed({ ...baseClaims(), iat: now + 600 }));
  invalid(signed({ ...baseClaims(), nbf: 'tomorrow' }));
  assert.equal(verifyExtensionToken(signed({ ...baseClaims(), nbf: now + 15, iat: now + 15 }), secret).role, 'viewer');
});

test('identities require bounded numeric channel IDs, opaque IDs, and accepted frontend roles', () => {
  for (const channel_id of ['', '0', '123abc', '12/34', '1'.repeat(26), 123, null]) invalid(signed({ ...baseClaims(), channel_id }));
  for (const opaque_user_id of ['', 'viewer123', 'U', 'Uhas spaces', `U${'a'.repeat(128)}`, 123]) invalid(signed({ ...baseClaims(), opaque_user_id }));
  for (const role of ['external', 'admin', '', null, ['moderator']]) invalid(signed({ ...baseClaims(), role }));
  invalid(signed({ exp: Math.floor(Date.now() / 1000) + 300, role: 'viewer' }));
  invalid(signed({ ...baseClaims(), user_id: 'not-numeric' }));
  invalid(signed({ ...baseClaims(), role: 'broadcaster', user_id: '99999999' }));
  assert.equal(verifyExtensionToken(signed({ ...baseClaims(), role: 'broadcaster', user_id: '12345678' }), secret).role, 'broadcaster');
});

test('optional client and audience claims are checked when present rather than required', () => {
  assert.equal(verifyExtensionToken(signed(), secret, expectedClient).role, 'viewer');
  assert.equal(verifyExtensionToken(signed({ ...baseClaims(), client_id: expectedClient, aud: [expectedClient] }), secret, expectedClient).role, 'viewer');
  invalid(signed({ ...baseClaims(), client_id: 'anotherclient' }));
  invalid(signed({ ...baseClaims(), clientId: 'anotherclient' }));
  invalid(signed({ ...baseClaims(), aud: 'anotherclient' }));
  invalid(signed({ ...baseClaims(), aud: [] }));
  invalid(signed({ ...baseClaims(), aud: { client: expectedClient } }));
});

test('malformed JSON, noncanonical base64url, oversized tokens, and short secrets fail closed', () => {
  for (const token of ['', 'not-a-token', '.a.b', `${'x'.repeat(12_289)}`, 'eyJhbGciOiJIUzI1NiJ9.e30=.AA']) invalid(token);
  const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
  for (const text of ['not-json', 'null', '[]', '"string"']) {
    const payload = Buffer.from(text).toString('base64url');
    invalid(`${header}.${payload}.${createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')}`);
  }
  invalid(signed(), randomBytes(31).toString('base64'));
  invalid(signed(), `${secret}\n`);
  invalid(signed(), 'not-a-base64-secret');
});

test('request extraction accepts one Bearer or custom JWT header and rejects ambiguous auth', () => {
  const token = signed();
  const expected = verifyExtensionToken(token, secret);
  assert.deepEqual(getExtensionIdentity({ headers: { authorization: `Bearer ${token}` } }, secret), expected);
  assert.deepEqual(getExtensionIdentity({ headers: { 'x-extension-jwt': token } }, secret), expected);
  assert.equal(getExtensionIdentity({ headers: {} }, secret), null);
  for (const headers of [
    { authorization: `Basic ${token}` }, { authorization: `Bearer  ${token}` },
    { authorization: `Bearer ${token}`, 'x-extension-jwt': token },
    { 'x-extension-jwt': [token, token] }, { authorization: '' },
  ]) assert.throws(() => getExtensionIdentity({ headers }, secret), ExtensionAuthError);
});
