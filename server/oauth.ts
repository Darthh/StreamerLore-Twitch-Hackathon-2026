import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Router } from 'express';

export type TwitchAccount = { channelId: string; login: string; displayName: string; profileImageUrl: string };
export type TwitchUserProfile = { id: string; login: string; displayName: string };
type Credentials = { accessToken: string; refreshToken: string; expiresAt: number };
type Options = {
  databasePath: string; encryptionKey: string; clientId: string; clientSecret: string; redirectUri: string;
  onConnect: (account: TwitchAccount) => void | Promise<void>;
  onDisconnect: (channelId: string) => void | Promise<void>;
};
type AccountRow = { channel_id: string; login: string; display_name: string; profile_image_url: string; credentials: Uint8Array };
const scopes = ['user:read:chat', 'user:write:chat'];
const channelPattern = /^\d{1,25}$/;

export function createTwitchOAuth(options: Options) {
  const key = Buffer.from(options.encryptionKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== options.encryptionKey) throw new Error('STREAMLORE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  if (!options.clientId.trim() || !options.clientSecret.trim()) throw new Error('Twitch OAuth requires TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.');
  const redirect = new URL(options.redirectUri);
  if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname))) throw new Error('Twitch OAuth redirect URI must use HTTPS (HTTP is allowed only on localhost).');
  if (redirect.username || redirect.password || redirect.hash || redirect.search) throw new Error('Twitch OAuth redirect URI must not contain credentials, query parameters, or a fragment.');
  if (options.databasePath !== ':memory:') mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(options.databasePath);
  db.exec('PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS twitch_oauth_accounts (channel_id TEXT PRIMARY KEY, login TEXT NOT NULL, display_name TEXT NOT NULL, profile_image_url TEXT NOT NULL, credentials BLOB NOT NULL)');
  const states = new Map<string, { channelId: string; expiresAt: number; generation: number }>();
  const generations = new Map<string, number>();
  const refreshing = new Map<string, Promise<string>>();
  let closed = false;
  const router = Router();

  function assertOpen() { if (closed) throw new Error('Twitch account store is closed.'); }
  function validChannel(channelId: string) { if (!channelPattern.test(channelId)) throw new Error('A valid Twitch channel ID is required.'); }
  function row(channelId: string): AccountRow | undefined {
    assertOpen(); validChannel(channelId);
    return db.prepare('SELECT * FROM twitch_oauth_accounts WHERE channel_id = ?').get(channelId) as AccountRow | undefined;
  }
  function profile(value: AccountRow): TwitchAccount {
    return { channelId: value.channel_id, login: value.login, displayName: value.display_name, profileImageUrl: value.profile_image_url };
  }
  function encrypt(channelId: string, credentials: Credentials): Buffer {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`streamlore:twitch:${channelId}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }
  function decrypt(channelId: string, encrypted: Uint8Array): Credentials {
    try {
      const bytes = Buffer.from(encrypted), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`streamlore:twitch:${channelId}`)); decipher.setAuthTag(bytes.subarray(12, 28));
      const result = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
      if (typeof result.accessToken !== 'string' || typeof result.refreshToken !== 'string' || !Number.isFinite(result.expiresAt)) throw new Error();
      return result;
    } catch { throw new Error('Stored Twitch credentials could not be decrypted. Restore the encryption key or reconnect the channel.'); }
  }

  async function providerRequest(url: string, init: RequestInit = {}): Promise<Record<string, any>> {
    let response: Response;
    try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }); }
    catch { throw new Error('Twitch could not be reached. Try connecting again.'); }
    if (!response.ok) throw new Error(`Twitch authorization request failed (${response.status}). Reconnect your channel to try again.`);
    try {
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      return data;
    } catch { throw new Error('Twitch returned an invalid authorization response. Try connecting again.'); }
  }

  async function tokenRequest(parameters: Record<string, string>): Promise<Credentials> {
    const result = await providerRequest('https://id.twitch.tv/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, ...parameters }),
    });
    if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 4096 || typeof result.refresh_token !== 'string' || !result.refresh_token || result.refresh_token.length > 4096 || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 366 * 24 * 60 * 60) throw new Error('Twitch did not return valid refreshable credentials. Reconnect the channel.');
    return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: Date.now() + result.expires_in * 1000 };
  }

  async function validateToken(channelId: string, accessToken: string) {
    const token = await providerRequest('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } });
    if (token.client_id !== options.clientId || token.user_id !== channelId) throw new Error('The Twitch account you authorized does not match this channel. Sign in as its broadcaster and try again.');
    if (!Array.isArray(token.scopes) || !scopes.every(scope => token.scopes.includes(scope))) throw new Error('Both Twitch chat permissions are required. Reconnect and allow reading and sending chat messages.');
  }

  async function revoke(accessToken: string) {
    try {
      await fetch('https://id.twitch.tv/oauth2/revoke', {
        method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: options.clientId, token: accessToken }),
      });
    } catch { /* Local removal still completes if Twitch is unavailable. */ }
  }

  function account(channelId: string): TwitchAccount | null { const value = row(channelId); return value ? profile(value) : null; }
  function listAccounts(): TwitchAccount[] {
    assertOpen();
    return (db.prepare('SELECT * FROM twitch_oauth_accounts ORDER BY channel_id').all() as AccountRow[]).map(profile);
  }

  function begin(channelId: string): string {
    assertOpen(); validChannel(channelId);
    for (const [state, pending] of states) if (pending.expiresAt <= Date.now() || pending.channelId === channelId) states.delete(state);
    if (states.size >= 2000) throw new Error('Too many pending Twitch connections. Please try again in five minutes.');
    const generation = (generations.get(channelId) || 0) + 1;
    generations.set(channelId, generation);
    const state = randomBytes(32).toString('base64url');
    states.set(state, { channelId, expiresAt: Date.now() + 5 * 60_000, generation });
    const authorize = new URL('https://id.twitch.tv/oauth2/authorize');
    authorize.search = new URLSearchParams({ client_id: options.clientId, redirect_uri: options.redirectUri, response_type: 'code', scope: scopes.join(' '), force_verify: 'true', state }).toString();
    return authorize.toString();
  }

  function finishPage(response: import('express').Response, status: number, success: boolean) {
    response.status(status).set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }).type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>StreamLore · Twitch connection</title><style>body{background:#f7f8fa;color:#20212b;font:16px/1.6 system-ui;margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:460px;padding:36px;border:1px solid #e7e4ef;border-radius:22px;background:white;margin:20px}h1{font-size:26px;line-height:1.3}a{color:#7042d7}small{color:#687080}</style><main><small>STREAMLORE</small><h1>${success ? 'Your channel is connected.' : 'We could not connect your channel.'}</h1><p>${success ? 'Chat is authorized. Return to your StreamLore extension configuration to check its connection and start welcoming viewers.' : 'This connection request expired, was already used, was declined, or did not authorize the correct broadcaster with both chat permissions. Start a new connection from your StreamLore extension configuration.'}</p><a href="https://dashboard.twitch.tv/extensions" rel="noreferrer">Return to Twitch extensions</a><p><small>You can close this tab. Your access tokens stay on the StreamLore server.</small></p></main></html>`);
  }

  router.get('/callback', async (request, response) => {
    if (closed) return finishPage(response, 503, false);
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const pending = states.get(state);
    if (pending) states.delete(state);
    if (!pending || pending.expiresAt <= Date.now() || generations.get(pending.channelId) !== pending.generation || request.query.error || typeof request.query.code !== 'string' || !request.query.code || request.query.code.length > 4096) return finishPage(response, 400, false);
    let credentials: Credentials | undefined;
    let stored = false;
    try {
      credentials = await tokenRequest({ grant_type: 'authorization_code', code: request.query.code, redirect_uri: options.redirectUri });
      await validateToken(pending.channelId, credentials.accessToken);
      const users = await providerRequest('https://api.twitch.tv/helix/users', { headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Client-Id': options.clientId } });
      const user = users.data?.[0];
      if (!user || user.id !== pending.channelId || typeof user.login !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(user.login) || typeof user.display_name !== 'string') throw new Error('Twitch profile did not match the authorized broadcaster.');
      assertOpen();
      if (generations.get(pending.channelId) !== pending.generation) throw new Error('Connection was superseded or disconnected.');
      if (!account(pending.channelId) && (db.prepare('SELECT COUNT(*) AS count FROM twitch_oauth_accounts').get()?.count as number) >= 1000) throw new Error('The connected-channel limit has been reached.');
      const connected: TwitchAccount = { channelId: pending.channelId, login: user.login, displayName: user.display_name.slice(0, 100), profileImageUrl: typeof user.profile_image_url === 'string' && user.profile_image_url.startsWith('https://') ? user.profile_image_url.slice(0, 1000) : '' };
      db.prepare('INSERT INTO twitch_oauth_accounts (channel_id, login, display_name, profile_image_url, credentials) VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET login=excluded.login, display_name=excluded.display_name, profile_image_url=excluded.profile_image_url, credentials=excluded.credentials').run(connected.channelId, connected.login, connected.displayName, connected.profileImageUrl, encrypt(connected.channelId, credentials));
      stored = true;
      await options.onConnect(connected);
      return finishPage(response, 200, true);
    } catch {
      if (credentials && !stored) await revoke(credentials.accessToken);
      return finishPage(response, 400, false);
    }
  });

  async function getAccessToken(channelId: string, forceRefresh = false): Promise<string> {
    const current = row(channelId);
    if (!current) throw new Error('This channel has not connected Twitch chat. Connect it from the extension configuration.');
    const credentials = decrypt(channelId, current.credentials);
    if (!forceRefresh && credentials.expiresAt > Date.now() + 60_000) return credentials.accessToken;
    const existing = refreshing.get(channelId);
    if (existing) return existing;
    const refresh = (async () => {
      const next = await tokenRequest({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
      try {
        await validateToken(channelId, next.accessToken);
        assertOpen();
        const result = db.prepare('UPDATE twitch_oauth_accounts SET credentials = ? WHERE channel_id = ? AND credentials = ?').run(encrypt(channelId, next), channelId, current.credentials);
        if (result.changes !== 1) throw new Error('Twitch connection changed during refresh. Reconnect if needed.');
      } catch (error) { await revoke(next.accessToken); throw error; }
      return next.accessToken;
    })();
    refreshing.set(channelId, refresh);
    try { return await refresh; } finally { if (refreshing.get(channelId) === refresh) refreshing.delete(channelId); }
  }

  async function resolveUser(channelId: string, userId: string): Promise<TwitchUserProfile> {
    if (!account(channelId)) throw new Error('Connect your Twitch account before publishing from this channel.');
    if (!channelPattern.test(userId)) throw new Error('A valid Twitch user ID is required for creator attribution.');
    const accessToken = await getAccessToken(channelId);
    const result = await providerRequest(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': options.clientId },
    });
    const user = result.data?.[0];
    if (!user || user.id !== userId || typeof user.login !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(user.login) || typeof user.display_name !== 'string' || !user.display_name.trim() || user.display_name.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(user.display_name)) throw new Error('Twitch could not verify this creator profile. Try publishing again.');
    return { id: user.id, login: user.login, displayName: user.display_name };
  }

  async function disconnect(channelId: string): Promise<void> {
    const current = row(channelId);
    generations.set(channelId, (generations.get(channelId) || 0) + 1);
    for (const [state, pending] of states) if (pending.channelId === channelId) states.delete(state);
    db.prepare('DELETE FROM twitch_oauth_accounts WHERE channel_id = ?').run(channelId);
    let token: string | undefined;
    if (current) { try { token = decrypt(channelId, current.credentials).accessToken; } catch { /* Corrupt credentials must still be removable. */ } }
    try { await options.onDisconnect(channelId); } finally { if (token) await revoke(token); }
  }

  function close() { if (closed) return; closed = true; states.clear(); db.close(); }
  return { router, begin, account, getAccessToken, resolveUser, disconnect, listAccounts, close };
}
