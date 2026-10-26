import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import express from 'express';
import { createTwitchOAuth, type TwitchAccount } from '../server/oauth.ts';

type FetchCall = { url: string; init: RequestInit };
type Provider = (call: FetchCall) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const credentials = { access_token: 'private-access-token-one', refresh_token: 'private-refresh-token-one', expires_in: 3600 };
const valid = { client_id: 'client-id', user_id: '12345', scopes: ['user:read:chat', 'user:write:chat'] };
const user = { id: '12345', login: 'testchannel', display_name: 'Test Channel', profile_image_url: 'https://static-cdn.jtvnw.net/avatar.png' };

async function fixture(t: TestContext, override?: Provider) {
  const directory = mkdtempSync(join(tmpdir(), 'streamlore-oauth-'));
  const calls: FetchCall[] = [], connected: TwitchAccount[] = [], disconnected: string[] = [];
  let provider = override;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init }; calls.push(call);
    if (provider) return provider(call);
    if (call.url.endsWith('/token')) return json(credentials);
    if (call.url.endsWith('/validate')) return json(valid);
    if (call.url.endsWith('/users')) return json({ data: [user] });
    if (call.url.endsWith('/revoke')) return new Response(null, { status: 200 });
    throw new Error('Unexpected provider request');
  });
  const options = { databasePath: join(directory, 'oauth.sqlite'), encryptionKey: randomBytes(32).toString('base64'), clientId: 'client-id', clientSecret: 'private-client-secret', redirectUri: 'https://streamlore.example/auth/twitch/callback', onConnect(account: TwitchAccount) { connected.push(account); }, onDisconnect(channelId: string) { disconnected.push(channelId); } };
  const oauth = createTwitchOAuth(options);
  const app = express(); app.use('/auth/twitch', oauth.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start');
  const callback = (query: Record<string, string>) => new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path: `/auth/twitch/callback?${new URLSearchParams(query)}` }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode!, body, headers: response.headers }));
    }); req.on('error', reject); req.end();
  });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    oauth.close(); rmSync(directory, { recursive: true, force: true });
  });
  const state = (channelId = '12345') => new URL(oauth.begin(channelId)).searchParams.get('state')!;
  const connect = (channelId = '12345') => callback({ state: state(channelId), code: 'authorization-code' });
  return { oauth, options, calls, connected, disconnected, callback, connect, state, setProvider(next: Provider) { provider = next; } };
}

test('OAuth start uses a random state bound to a numeric channel and only the two chat scopes', async t => {
  const f = await fixture(t);
  const first = new URL(f.oauth.begin('12345')), second = new URL(f.oauth.begin('12345'));
  assert.equal(first.origin + first.pathname, 'https://id.twitch.tv/oauth2/authorize');
  assert.equal(first.searchParams.get('response_type'), 'code');
  assert.equal(first.searchParams.get('force_verify'), 'true');
  assert.equal(first.searchParams.get('redirect_uri'), f.options.redirectUri);
  assert.equal(first.searchParams.get('scope'), 'user:read:chat user:write:chat');
  assert.ok(first.searchParams.get('state')!.length >= 40);
  assert.notEqual(first.searchParams.get('state'), second.searchParams.get('state'));
  assert.throws(() => f.oauth.begin('../other-channel'), /valid Twitch channel/);
  assert.equal((await f.callback({ state: first.searchParams.get('state')!, code: 'old' })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('successful authorization validates identity and stores only encrypted credentials', async t => {
  const f = await fixture(t);
  const result = await f.connect();
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.ok(result.headers['content-security-policy']?.includes("frame-ancestors 'none'"));
  assert.equal(await f.oauth.getAccessToken('12345'), credentials.access_token);
  assert.deepEqual(f.oauth.account('12345'), { channelId: '12345', login: user.login, displayName: user.display_name, profileImageUrl: user.profile_image_url });
  assert.deepEqual(f.oauth.listAccounts(), f.connected);
  const tokenRequest = new URLSearchParams(f.calls[0].init.body as URLSearchParams);
  assert.equal(tokenRequest.get('grant_type'), 'authorization_code');
  assert.equal(tokenRequest.get('code'), 'authorization-code');
  assert.equal(tokenRequest.get('client_secret'), f.options.clientSecret);
  const bytes = readFileSync(f.options.databasePath);
  for (const secret of [credentials.access_token, credentials.refresh_token, f.options.clientSecret]) {
    assert.ok(!bytes.includes(Buffer.from(secret)));
    assert.ok(!result.body.includes(secret));
    assert.ok(!JSON.stringify(f.oauth.account('12345')).includes(secret));
  }
  f.oauth.close();
  const reopened = createTwitchOAuth(f.options);
  assert.equal(await reopened.getAccessToken('12345'), credentials.access_token);
  assert.equal(reopened.listAccounts().length, 1);
  reopened.close();
});

test('unknown, expired, and replayed OAuth states cannot create accounts', async t => {
  const f = await fixture(t);
  assert.equal((await f.callback({ state: 'unknown', code: 'code' })).status, 400);
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const state = f.state();
  t.mock.method(Date, 'now', () => now + 5 * 60_000);
  assert.equal((await f.callback({ state, code: 'code' })).status, 400);
  assert.equal(f.calls.length, 0);
  t.mock.method(Date, 'now', () => now);
  const fresh = f.state();
  assert.equal((await f.callback({ state: fresh, code: 'code' })).status, 200);
  const count = f.calls.length;
  assert.equal((await f.callback({ state: fresh, code: 'code' })).status, 400);
  assert.equal(f.calls.length, count);
});

test('declined, missing, and malformed codes consume their state without provider calls', async t => {
  const f = await fixture(t);
  for (const query of [{ error: '<script>alert(1)</script>' }, {}, { code: '' }, { code: 'x'.repeat(4097) }] as Record<string, string>[]) {
    const state = f.state();
    const result = await f.callback({ state, ...query });
    assert.equal(result.status, 400);
    assert.ok(!result.body.includes('<script>'));
    assert.equal((await f.callback({ state, code: 'now-valid' })).status, 400);
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.oauth.listAccounts(), []);
});

test('wrong broadcaster, wrong client, missing scopes, or wrong profile cannot link a channel', async t => {
  const f = await fixture(t);
  const invalidTokens = [{ ...valid, user_id: '99999' }, { ...valid, client_id: 'other-client' }, { ...valid, scopes: ['user:read:chat'] }];
  for (const invalid of invalidTokens) {
    f.setProvider(({ url }) => url.endsWith('/token') ? json(credentials) : url.endsWith('/validate') ? json(invalid) : new Response(null, { status: 200 }));
    assert.equal((await f.connect()).status, 400);
    assert.equal(f.oauth.account('12345'), null);
  }
  f.setProvider(({ url }) => url.endsWith('/token') ? json(credentials) : url.endsWith('/validate') ? json(valid) : url.endsWith('/users') ? json({ data: [{ ...user, id: '99999' }] }) : new Response(null, { status: 200 }));
  assert.equal((await f.connect()).status, 400);
  assert.deepEqual(f.connected, []);
  assert.equal(f.oauth.account('99999'), null);
});

test('provider failures never expose provider error bodies or create accounts', async t => {
  const f = await fixture(t, () => json({ error: 'private-provider-detail', access_token: 'leaked-token' }, 400));
  const result = await f.connect();
  assert.equal(result.status, 400);
  assert.ok(!result.body.includes('private-provider-detail'));
  assert.ok(!result.body.includes('leaked-token'));
  assert.deepEqual(f.oauth.listAccounts(), []);
  await assert.rejects(f.oauth.getAccessToken('12345'), /has not connected/);
});

test('near-expiry refresh is deduplicated and rotates encrypted credentials atomically', async t => {
  const f = await fixture(t);
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  assert.equal((await f.connect()).status, 200);
  const next = { access_token: 'private-rotated-access', refresh_token: 'private-rotated-refresh', expires_in: 3600 };
  let refreshes = 0;
  f.setProvider(async ({ url, init }) => {
    if (url.endsWith('/token')) {
      refreshes++;
      const params = new URLSearchParams(init.body as URLSearchParams);
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('refresh_token'), credentials.refresh_token);
      await new Promise(resolve => setImmediate(resolve)); return json(next);
    }
    return json(valid);
  });
  t.mock.method(Date, 'now', () => now + 3545_000);
  assert.deepEqual(await Promise.all([f.oauth.getAccessToken('12345'), f.oauth.getAccessToken('12345'), f.oauth.getAccessToken('12345')]), [next.access_token, next.access_token, next.access_token]);
  assert.equal(refreshes, 1);
  assert.equal(await f.oauth.getAccessToken('12345'), next.access_token);
  assert.equal(refreshes, 1);
  assert.ok(!readFileSync(f.options.databasePath).includes(Buffer.from(next.refresh_token)));
  f.oauth.close();
  const reopened = createTwitchOAuth(f.options);
  assert.equal(await reopened.getAccessToken('12345'), next.access_token);
  reopened.close();
});

test('forced refresh supports recovery from 401 and uses the latest refresh token on the next refresh', async t => {
  const f = await fixture(t); await f.connect();
  let sequence = 0;
  f.setProvider(({ url, init }) => {
    if (url.endsWith('/token')) {
      const params = new URLSearchParams(init.body as URLSearchParams);
      assert.equal(params.get('refresh_token'), sequence === 0 ? credentials.refresh_token : 'refresh-1');
      sequence++; return json({ access_token: `access-${sequence}`, refresh_token: `refresh-${sequence}`, expires_in: 3600 });
    }
    return json(valid);
  });
  assert.equal(await f.oauth.getAccessToken('12345', true), 'access-1');
  assert.equal(await f.oauth.getAccessToken('12345', true), 'access-2');
  assert.equal(sequence, 2);
});

test('failed refresh preserves the previous encrypted account and returns a safe reconnect error', async t => {
  const f = await fixture(t); await f.connect();
  f.setProvider(() => json({ message: credentials.refresh_token }, 401));
  await assert.rejects(f.oauth.getAccessToken('12345', true), error => error instanceof Error && error.message.includes('Reconnect') && !error.message.includes(credentials.refresh_token));
  assert.equal(f.oauth.account('12345')?.channelId, '12345');
  assert.equal(await f.oauth.getAccessToken('12345'), credentials.access_token);
});

test('disconnect removes only its channel, cancels pending callbacks, and revokes best effort', async t => {
  const f = await fixture(t); await f.connect();
  f.setProvider(({ url }) => url.endsWith('/token') ? json({ ...credentials, access_token: 'other-channel-access' }) : url.endsWith('/validate') ? json({ ...valid, user_id: '67890' }) : json({ data: [{ ...user, id: '67890', login: 'otherchannel' }] }));
  assert.equal((await f.connect('67890')).status, 200);
  const pending = f.state();
  let revoked = false;
  f.setProvider(({ url, init }) => {
    assert.ok(url.endsWith('/revoke'));
    revoked = new URLSearchParams(init.body as URLSearchParams).get('token') === credentials.access_token;
    throw new Error('offline');
  });
  await f.oauth.disconnect('12345');
  assert.equal(revoked, true);
  assert.deepEqual(f.disconnected, ['12345']);
  assert.equal(f.oauth.account('12345'), null);
  assert.equal(f.oauth.account('67890')?.login, 'otherchannel');
  assert.equal(await f.oauth.getAccessToken('67890'), 'other-channel-access');
  assert.equal((await f.callback({ state: pending, code: 'code' })).status, 400);
  await assert.rejects(f.oauth.getAccessToken('12345'), /has not connected/);
});

test('in-flight refresh cannot resurrect disconnected credentials', async t => {
  const f = await fixture(t); await f.connect();
  let release: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.setProvider(async ({ url }) => {
    if (url.endsWith('/token')) { await waiting; return json({ ...credentials, access_token: 'orphaned-refreshed-token' }); }
    if (url.endsWith('/validate')) return json(valid);
    return new Response(null, { status: 200 });
  });
  const refreshing = f.oauth.getAccessToken('12345', true);
  await f.oauth.disconnect('12345'); release!();
  await assert.rejects(refreshing, /connection changed/);
  assert.equal(f.oauth.account('12345'), null);
});

test('encryption key mismatch fails closed while allowing credential removal', async t => {
  const f = await fixture(t); await f.connect(); f.oauth.close();
  const wrong = createTwitchOAuth({ ...f.options, encryptionKey: randomBytes(32).toString('base64') });
  await assert.rejects(wrong.getAccessToken('12345'), /could not be decrypted/);
  await wrong.disconnect('12345');
  assert.equal(wrong.account('12345'), null); wrong.close();
  assert.throws(() => createTwitchOAuth({ ...f.options, encryptionKey: 'weak-key' }), /32-byte key/);
  assert.throws(() => createTwitchOAuth({ ...f.options, redirectUri: 'http://public.example/callback' }), /HTTPS/);
});

test('creator attribution resolves the verified user ID with the connected channel grant', async t => {
  const f = await fixture(t); await f.connect();
  f.setProvider(({ url, init }) => {
    assert.equal(url, 'https://api.twitch.tv/helix/users?id=67890');
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${credentials.access_token}`);
    assert.equal(new Headers(init.headers).get('Client-Id'), 'client-id');
    return json({ data: [{ id: '67890', login: 'verifiedcreator', display_name: 'Verified Creator' }] });
  });
  assert.deepEqual(await f.oauth.resolveUser('12345', '67890'), { id: '67890', login: 'verifiedcreator', displayName: 'Verified Creator' });
});

test('creator attribution requires a channel grant and rejects mismatched or unavailable profiles', async t => {
  const f = await fixture(t);
  await assert.rejects(f.oauth.resolveUser('12345', '67890'), /Connect your Twitch account before publishing/);
  assert.equal(f.calls.length, 0);
  await f.connect();
  await assert.rejects(f.oauth.resolveUser('12345', '../67890'), /valid Twitch user ID/);
  f.setProvider(() => json({ data: [{ ...user, id: 'wrong-user' }] }));
  await assert.rejects(f.oauth.resolveUser('12345', '67890'), /could not verify this creator/);
  f.setProvider(() => json({ data: [{ ...user, id: '67890', display_name: 'x'.repeat(101) }] }));
  await assert.rejects(f.oauth.resolveUser('12345', '67890'), /could not verify this creator/);
  f.setProvider(() => json({ error: credentials.access_token }, 503));
  await assert.rejects(f.oauth.resolveUser('12345', '67890'), error => error instanceof Error && error.message.includes('503') && !error.message.includes(credentials.access_token));
});
