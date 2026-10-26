import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import express from 'express';
import { createExtensionHost } from '../server/extension-host.ts';

const extensionId = 'streamloreextension123';
const origin = `https://${extensionId}.ext-twitch.tv`;
const key = randomBytes(32);
const secret = key.toString('base64');
type Identity = { channelId?: string; role?: 'viewer' | 'moderator' | 'broadcaster'; userId?: string; opaqueUserId?: string };
function token({ channelId = '12345', role = 'viewer', userId, opaqueUserId = 'Ustableviewer' }: Identity = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, channel_id: channelId, role, opaque_user_id: opaqueUserId, ...(userId ? { user_id: userId } : {}) })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')}`;
}
const owner = () => token({ role: 'broadcaster', userId: '12345', opaqueUserId: 'U12345' });
const lore = { term: 'Moon cheese', aliases: ['cheese'], explanation: 'The community name for the round yellow platform.', origin: 'The streamer explained this name in a confirmed note.', category: 'Inside joke', clipUrl: '' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

async function fixture(t: TestContext, { configured = true, oauth = false }: { configured?: boolean; oauth?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'streamlore-extension-'));
  const providerCalls: string[] = [];
  let chatStarted = 0, chatClosed = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const target = String(url); providerCalls.push(target);
    if (target === 'https://id.twitch.tv/oauth2/token') return json({ access_token: 'private-access-token', refresh_token: 'private-refresh-token', expires_in: 3600 });
    if (target === 'https://id.twitch.tv/oauth2/validate') return json({ client_id: 'oauth-client', user_id: '12345', scopes: ['user:read:chat', 'user:write:chat'] });
    if (target.startsWith('https://api.twitch.tv/helix/users')) {
      const id = new URL(target).searchParams.get('id') || '12345';
      return json({ data: [{ id, login: id === '12345' ? 'teststreamer' : 'testmoderator', display_name: id === '12345' ? 'Test Streamer' : 'Test Moderator', profile_image_url: 'https://static-cdn.jtvnw.net/profile.png' }] });
    }
    if (target === 'https://id.twitch.tv/oauth2/revoke') return json({});
    throw new Error('Unexpected provider URL; live network is disabled in this test.');
  });
  const host = createExtensionHost({
    ...(configured ? { clientId: extensionId, secret } : {}), publicUrl: 'https://streamlore.example', dataDirectory: directory,
    ...(oauth ? { oauth: { clientId: 'oauth-client', clientSecret: 'private-client-secret', redirectUri: 'https://streamlore.example/auth/twitch/callback', encryptionKey: randomBytes(32).toString('base64') } } : {}),
    chatFactory: () => { chatStarted++; return { close() { chatClosed++; } }; },
  });
  const app = express(); app.use(host.router);
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start.');
  const port = address.port;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    host.close(); rmSync(directory, { recursive: true, force: true });
  });
  function call(path: string, { method = 'GET', jwt, body, headers = {} }: { method?: string; jwt?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    return new Promise<{ status: number; body: string; data: any; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const outgoing = request({ hostname: '127.0.0.1', port, path, method,
        headers: { ...(jwt ? { Authorization: `Bearer ${jwt}`, Origin: origin } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers },
      }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk);
        response.on('end', () => {
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = null; }
          resolve({ status: response.statusCode!, body: text, data, headers: response.headers });
        });
      });
      outgoing.on('error', reject); outgoing.end(payload);
    });
  }
  async function connect() {
    const begin = await call('/api/extension/connect', { method: 'POST', jwt: owner(), body: {} });
    assert.equal(begin.status, 200);
    const state = new URL(begin.data.url).searchParams.get('state');
    assert.ok(state);
    const callback = await call(`/auth/twitch/callback?${new URLSearchParams({ state, code: 'test-code' })}`);
    assert.equal(callback.status, 200);
  }
  return { host, call, connect, providerCalls, chatCounts: () => ({ started: chatStarted, closed: chatClosed }) };
}

test('unconfigured native host reports missing setup without pretending to be released', async t => {
  const f = await fixture(t, { configured: false });
  const setup = await f.call('/api/install/status');
  assert.equal(setup.status, 200);
  assert.equal(setup.data.extension.registered, false);
  assert.equal(setup.data.extension.released, false);
  assert.equal(setup.data.extension.installUrl, null);
  assert.equal(setup.data.backend.configured, false);
  assert.ok(setup.data.missing.length >= 3);
  assert.equal((await f.call('/api/extension/state')).status, 503);
  assert.deepEqual(f.providerCalls, []);
});

test('native authentication and exact origin boundaries reject unsigned, tampered, and cross-site requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/extension/state')).status, 401);
  assert.equal((await f.call('/api/extension/state', { jwt: 'not.a.token' })).status, 401);
  const segments = token().split('.');
  segments[1] = Buffer.from(JSON.stringify({ channel_id: '456', role: 'broadcaster', exp: 9999999999, opaque_user_id: 'U12345' })).toString('base64url');
  assert.equal((await f.call('/api/extension/state', { jwt: segments.join('.') })).status, 401);
  assert.equal((await f.call('/api/extension/state', { jwt: token(), headers: { Origin: 'https://attacker.example' } })).status, 403);
  const allowed = await f.call('/api/extension/state', { jwt: token() });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], origin);
  const preflight = await f.call('/api/extension/state', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(preflight.status, 204);
  assert.match(String(preflight.headers['access-control-allow-headers']), /Authorization/);
});

test('native viewers start with empty channel history and cannot select a different channel with request data', async t => {
  const f = await fixture(t);
  const state = await f.call('/api/extension/state?channelId=456', { jwt: token() });
  assert.equal(state.status, 200);
  assert.equal(state.data.mode, 'live');
  assert.deepEqual(state.data.lore, []);
  assert.deepEqual(state.data.moments, []);
  assert.deepEqual(state.data.nominations, []);
  assert.ok(!state.body.includes('refrigerator'));
  assert.ok(!state.body.includes('TheDarthh'));
  const status = await f.call('/api/extension/status?channelId=456', { jwt: token() });
  assert.equal(status.data.channelId, '12345');
  assert.equal(status.data.viewerUrl, 'https://streamlore.example/channels/12345');
  assert.equal((await f.call('/api/extension/channels/456/state', { jwt: token() })).status, 404);
  const other = await f.call('/api/extension/status', { jwt: token({ channelId: '456' }) });
  assert.equal(other.data.channelId, '456');
  assert.equal(other.data.viewerUrl, 'https://streamlore.example/channels/456');
});

test('viewer, anonymous, unlinked moderator, and broadcaster role gates are enforced', async t => {
  const f = await fixture(t);
  const viewer = token();
  const anonymous = token({ opaqueUserId: 'Atemporarysession' });
  for (const jwt of [viewer, anonymous, token({ role: 'moderator' }), token({ role: 'broadcaster' })]) {
    assert.equal((await f.call('/api/extension/mod/state', { jwt })).status, 403);
    assert.equal((await f.call('/api/extension/mod/lore', { jwt, method: 'POST', body: lore })).status, 403);
  }
  assert.equal((await f.call('/api/extension/state', { jwt: anonymous })).status, 200);
  assert.equal((await f.call('/api/extension/lore/unknown/vote', { jwt: anonymous, method: 'POST', body: {} })).status, 403);
  assert.equal((await f.call('/api/extension/connect', { jwt: viewer, method: 'POST', body: {} })).status, 403);
  assert.equal((await f.call('/api/extension/connect', { jwt: token({ role: 'moderator', userId: '67890' }), method: 'POST', body: {} })).status, 403);
  assert.equal((await f.call('/api/extension/connect', { jwt: owner(), method: 'POST', body: {} })).status, 503);
  assert.equal((await f.call('/api/extension/mod/state', { jwt: owner() })).status, 200);
  const broadcasterWithoutOptionalId = token({ role: 'broadcaster', opaqueUserId: 'U12345' });
  assert.equal((await f.call('/api/extension/mod/state', { jwt: broadcasterWithoutOptionalId })).status, 200, 'a signed broadcaster identity remains usable on its own channel');
  assert.equal((await f.call('/api/extension/mod/lore', { jwt: owner(), method: 'POST', body: lore })).status, 409);
  assert.equal((await f.call('/api/extension/configure', { jwt: owner(), method: 'POST', body: {} })).status, 409);
});

test('public companion endpoints are read-only and never expose moderator state', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/channels/99999/api/state')).status, 404);
  await f.call('/api/extension/state', { jwt: token() });
  assert.equal((await f.call('/channels/12345/api/state')).status, 200);
  assert.equal((await f.call('/channels/12345/api/catchup')).status, 200);
  assert.equal((await f.call('/channels/12345/api/mod/state')).status, 403);
  assert.equal((await f.call('/channels/12345/api/mod/lore', { method: 'POST', body: lore })).status, 403);
  assert.equal((await f.call('/channels/12345/api/lore/unknown/vote', { method: 'POST', body: {} })).status, 403);
  assert.equal((await f.call('/channels/12345/api/auth/login', { method: 'POST', body: { password: 'anything' } })).status, 403);
});

test('native OAuth setup wires channel chat, server-derived authors, moderation, votes, and channel isolation', async t => {
  const f = await fixture(t, { oauth: true });
  await f.connect();
  assert.equal(f.chatCounts().started, 1);
  const status = await f.call('/api/extension/status', { jwt: owner() });
  assert.equal(status.data.connectedAccount.login, 'teststreamer');
  assert.equal(status.data.canModerate, true);
  assert.equal((await f.call('/api/extension/configure', { method: 'POST', jwt: owner(), body: {} })).status, 200);
  const created = await f.call('/api/extension/mod/lore', { method: 'POST', jwt: owner(), body: { ...lore, channelId: '456', author: { id: '999', login: 'forged', displayName: 'Forged author' } } });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'pending');
  assert.deepEqual(created.data.author, { id: '12345', login: 'teststreamer', displayName: 'Test Streamer' });
  const id = created.data.id;
  assert.ok(!(await f.call('/api/extension/state', { jwt: token() })).data.lore.some((item: { id: string }) => item.id === id));
  const wrongChannel = token({ channelId: '456', role: 'broadcaster', userId: '456', opaqueUserId: 'U456' });
  assert.deepEqual((await f.call('/api/extension/mod/state?channelId=12345', { jwt: wrongChannel })).data.pending, []);
  const moderator = token({ role: 'moderator', userId: '67890', opaqueUserId: 'Umoderator' });
  const approved = await f.call(`/api/extension/mod/lore/${id}`, { method: 'PATCH', jwt: moderator, body: { status: 'nominated', reviewedBy: { id: '999', login: 'forged', displayName: 'Forged reviewer' } } });
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.data.reviewedBy, { id: '67890', login: 'testmoderator', displayName: 'Test Moderator' });
  const voter = token({ opaqueUserId: 'Uuniquevoter' });
  const first = await f.call(`/api/extension/lore/${id}/vote`, { method: 'POST', jwt: voter, body: {} });
  assert.equal(first.status, 200);
  assert.equal(first.data.votes, 1);
  assert.equal(first.headers['set-cookie'], undefined, 'native votes use a verified opaque identity, not a browser cookie');
  assert.equal((await f.call(`/api/extension/lore/${id}/vote`, { method: 'POST', jwt: voter, body: {} })).status, 409);
  assert.equal((await f.call(`/api/extension/lore/${id}/vote`, { method: 'POST', jwt: wrongChannel, body: {} })).status, 404);
  assert.equal((await f.call(`/api/extension/mod/lore/${id}`, { method: 'PATCH', jwt: moderator, body: { status: 'approved' } })).status, 200);
  const published = await f.call('/channels/12345/api/state');
  assert.equal(published.data.lore[0].id, id);
  assert.equal(published.data.lore[0].author.login, 'teststreamer');
  assert.deepEqual((await f.call('/channels/456/api/state')).data.lore, []);
  const note = await f.call('/api/extension/mod/moments', { method: 'POST', jwt: moderator, body: { title: 'A verified moment', body: 'The challenge has been completed.', kind: 'milestone', author: { id: '999' } } });
  assert.equal(note.status, 201);
  assert.equal(note.data.moments[0].author.login, 'testmoderator');
  const removedMoment = await f.call(`/api/extension/mod/moments/${note.data.moments[0].id}`, { method: 'DELETE', jwt: moderator, body: {} });
  assert.equal(removedMoment.status, 200);
  assert.deepEqual(removedMoment.data.moments, []);
  assert.deepEqual(removedMoment.data.stream.summary, []);
  assert.equal((await f.call(`/api/extension/mod/lore/${id}`, { method: 'PATCH', jwt: moderator, body: { status: 'rejected' } })).status, 200);
  assert.deepEqual((await f.call('/channels/12345/api/state')).data.lore, []);
  assert.equal((await f.call('/api/extension/connection', { method: 'DELETE', jwt: moderator, body: {} })).status, 403);
  assert.equal((await f.call('/api/extension/connection', { method: 'DELETE', jwt: owner(), body: {} })).status, 200);
  assert.equal(f.chatCounts().closed, 1);
  assert.equal((await f.call('/api/extension/mod/lore', { method: 'POST', jwt: owner(), body: { ...lore, term: 'Another lore' } })).status, 409);
  assert.deepEqual((await f.call('/channels/12345/api/state')).data.lore, []);
});
