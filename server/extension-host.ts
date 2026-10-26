import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ContentAuthor } from '../shared/types.ts';
import { createStore } from './store.ts';
import { createApp } from './app.ts';
import { createTwitchOAuth, type TwitchAccount } from './oauth.ts';
import { getExtensionIdentity, ExtensionAuthError, type ExtensionIdentity } from './extension-auth.ts';
import { startTwitch } from './twitch.ts';

type Options = {
  clientId?: string; secret?: string; publicUrl: string; dataDirectory?: string;
  localTest?: boolean; extraOrigins?: string[]; released?: boolean; installUrl?: string;
  demoPreview?: boolean; maxChannels?: number; chatFactory?: typeof startTwitch;
  oauth?: { clientId: string; clientSecret: string; redirectUri: string; encryptionKey: string };
};
type Channel = { store: ReturnType<typeof createStore>; runtime: ReturnType<typeof createApp>; chat?: { close: () => void } };
class HostError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const channelIdPattern = /^[1-9]\d{0,24}$/;

export function createExtensionHost(options: Options) {
  const router = Router();
  const publicUrl = new URL(options.publicUrl);
  if (!['https:', 'http:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new Error('STREAMLORE_PUBLIC_URL must be an HTTP(S) origin for native Extension hosting.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !loopback) throw new Error('The native Extension backend requires public HTTPS.');
  const clientId = options.clientId?.trim() || '';
  if (clientId && !/^[a-zA-Z0-9]{1,100}$/.test(clientId)) throw new Error('TWITCH_EXTENSION_CLIENT_ID must be the Extension client ID from Twitch.');
  const secret = options.secret?.trim() || '';
  if (secret) {
    const decoded = Buffer.from(secret, 'base64');
    if (decoded.length < 32 || decoded.toString('base64') !== secret) throw new Error('TWITCH_EXTENSION_SECRET must be the base64 shared secret from Twitch.');
  }
  const enabled = Boolean(clientId && secret);
  const origins = new Set<string>([publicUrl.origin]);
  if (clientId) origins.add(`https://${clientId.toLowerCase()}.ext-twitch.tv`);
  for (const input of options.extraOrigins || []) {
    const url = new URL(input);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(options.localTest && local && url.protocol === 'http:'))) throw new Error('Extension allowed origins must be exact HTTPS origins; local HTTP requires STREAMLORE_EXTENSION_LOCAL_TEST=true.');
    origins.add(url.origin);
  }
  if (options.localTest) for (const port of [5173, 8787]) for (const host of ['localhost', '127.0.0.1']) origins.add(`http://${host}:${port}`);
  const directory = resolve(options.dataDirectory || 'data/extensions');
  const channels = new Map<string, Channel>();
  const identities = new WeakMap<Request, ExtensionIdentity>();
  const authors = new WeakMap<Request, ContentAuthor>();
  const maxChannels = options.maxChannels ?? 100;
  if (!Number.isSafeInteger(maxChannels) || maxChannels < 1 || maxChannels > 1000) throw new Error('STREAMLORE_MAX_CHANNELS must be between 1 and 1000.');
  let oauth: ReturnType<typeof createTwitchOAuth> | undefined;
  let closed = false;

  function channel(id: string, create = true): Channel {
    if (closed) throw new HostError(503, 'StreamLore is shutting down. Try again shortly.');
    if (!channelIdPattern.test(id)) throw new HostError(400, 'Invalid Twitch channel.');
    const cached = channels.get(id);
    if (cached) return cached;
    const filename = join(directory, `${id}.sqlite`);
    if (!create && !existsSync(filename)) throw new HostError(404, 'This channel has not configured StreamLore yet.');
    if (channels.size >= maxChannels) throw new HostError(503, 'This StreamLore host has reached its channel limit. Contact the operator.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const store = createStore(filename, false);
    const runtime = createApp({
      store, mode: 'live', publicUrl: `${publicUrl.origin}/channels/${id}`, staticFiles: false, extensionManaged: true,
      authorizeModerator: req => { const identity = identities.get(req); return identity?.channelId === id && Boolean(identity.userId) && ['broadcaster', 'moderator'].includes(identity.role); },
      trustedRequest: req => identities.get(req)?.channelId === id,
      voterIdentity: req => { const identity = identities.get(req); return identity?.channelId === id && identity.opaqueUserId.startsWith('U') ? `extension:${identity.opaqueUserId}` : undefined; },
      contentAuthor: req => authors.get(req),
    });
    const created = { store, runtime };
    channels.set(id, created);
    const account = oauth?.account(id);
    if (account) runtime.setChannel({ ...store.read().channel, login: account.login, displayName: account.displayName, profileImageUrl: account.profileImageUrl });
    return created;
  }
  function connect(account: TwitchAccount) {
    const entry = channel(account.channelId);
    entry.chat?.close();
    entry.runtime.setChannel({ ...entry.store.read().channel, login: account.login, displayName: account.displayName, profileImageUrl: account.profileImageUrl });
    entry.chat = (options.chatFactory || startTwitch)({
      config: { clientId: options.oauth!.clientId, channelLogin: account.login, getAccessToken: force => oauth!.getAccessToken(account.channelId, force) },
      onChat: entry.runtime.ingestChat, onStatus: entry.runtime.setTwitchStatus, onChannel: entry.runtime.setChannel,
      getCatchup: entry.runtime.catchup, getLore: entry.runtime.loreReply, voteLore: entry.runtime.voteLore,
    });
  }
  function disconnect(id: string) {
    const entry = channels.get(id);
    entry?.chat?.close();
    if (entry) { entry.chat = undefined; entry.runtime.setTwitchStatus({ configured: false, connected: false, message: 'Channel account disconnected. Public lore remains available.' }); }
  }
  if (options.oauth) {
    oauth = createTwitchOAuth({ ...options.oauth, databasePath: join(directory, 'accounts.sqlite'), onConnect: connect, onDisconnect: disconnect });
    router.use('/auth/twitch', oauth.router);
    for (const account of oauth.listAccounts().slice(0, maxChannels)) connect(account);
  }
  function installStatus() {
    let installUrl: string | null = null;
    if (options.installUrl) {
      const url = new URL(options.installUrl);
      if (url.protocol !== 'https:' || !['dashboard.twitch.tv', 'www.twitch.tv', 'twitch.tv'].includes(url.hostname) || url.username || url.password) throw new Error('TWITCH_EXTENSION_INSTALL_URL must be the actual HTTPS Twitch listing URL.');
      installUrl = url.href;
    }
    const archive = resolve('release/streamlore-twitch-extension.zip');
    const config = resolve('dist-extension/config.js');
    const localTest = existsSync(config) && /"localTest":true/.test(readFileSync(config, 'utf8'));
    const missing = [!clientId && 'Register the StreamLore Extension in the Twitch Developer Console.', !secret && 'Set the Extension shared secret on the backend.', !oauth && 'Register the chat OAuth app and configure its credentials and encryption key.', publicUrl.protocol !== 'https:' && 'Host the backend at a public HTTPS origin.', !(options.released && installUrl) && 'Complete Hosted Test, Twitch review, and release the Extension.'].filter((value): value is string => Boolean(value));
    return {
      extension: { registered: Boolean(clientId), clientId: clientId || null, released: Boolean(options.released && installUrl), installUrl: options.released ? installUrl : null },
      backend: { configured: enabled && publicUrl.protocol === 'https:' && !loopback, publicUrl: publicUrl.origin }, oauth: { configured: Boolean(oauth) },
      package: { available: existsSync(archive), localTest, url: '/downloads/streamlore-twitch-extension.zip' }, missing,
      previewUrl: options.demoPreview ? '/extension/panel.html?demo=1' : null,
    };
  }
  router.get('/api/install/status', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(installStatus()); });
  router.get('/install', (_req, res) => res.sendFile(resolve('public/install.html')));
  router.get(['/install.js', '/install.css'], (req, res) => res.sendFile(resolve(`public${req.path}`)));
  router.get('/extension/config.js', (_req, res) => {
    res.type('application/javascript').send(`export const extensionConfig = Object.freeze(${JSON.stringify({ apiOrigin: publicUrl.origin, localTest: Boolean(options.localTest || loopback) })});\n`);
  });
  router.use('/extension', express.static(resolve('extension'), { dotfiles: 'deny' }));
  router.get('/downloads/streamlore-twitch-extension.zip', (_req, res) => {
    const filename = resolve('release/streamlore-twitch-extension.zip');
    if (!existsSync(filename)) return res.status(404).json({ error: 'Build the Extension package first. See the native launch guide.' });
    res.download(filename, 'streamlore-twitch-extension.zip');
  });

  router.use('/api/extension', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return res.status(403).json({ error: 'This origin is not allowed to use the StreamLore Extension API.' });
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.vary('Origin'); }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Extension-JWT');
      res.setHeader('Access-Control-Max-Age', '600'); return res.sendStatus(204);
    }
    if (!enabled) return res.status(503).json({ error: 'The operator has not configured the Twitch Extension client ID and shared secret yet.' });
    try {
      const identity = getExtensionIdentity(req, secret, clientId);
      if (!identity) throw new ExtensionAuthError();
      // Twitch binds a broadcaster's stable opaque ID to that same numeric channel ID.
      // requestIdShare has no effect on the broadcaster's own channel.
      if (identity.role === 'broadcaster' && !identity.userId && identity.opaqueUserId === `U${identity.channelId}`) identity.userId = identity.channelId;
      identities.set(req, identity); next();
    } catch (error) { next(error); }
  });
  router.use('/api/extension', express.json({ limit: '80kb', strict: true }));
  router.use('/api/extension', async (req, res, next) => {
    try {
      const identity = identities.get(req)!;
      const entry = channel(identity.channelId);
      const account = oauth?.account(identity.channelId);
      const creatorRole = ['broadcaster', 'moderator'].includes(identity.role);
      const identityLinked = Boolean(identity.userId);
      if (req.method === 'GET' && req.path === '/status') return res.json({
        channelId: identity.channelId, role: identity.role, identityLinked, canManage: creatorRole && identityLinked,
        canModerate: creatorRole && identityLinked && Boolean(account), canVote: identity.opaqueUserId.startsWith('U'),
        chat: entry.runtime.state().connection.twitch, oauthConfigured: Boolean(oauth), configured: Boolean(entry.store.read().extensionConfigured),
        viewerUrl: `${publicUrl.origin}/channels/${identity.channelId}`, overlayUrl: `${publicUrl.origin}/channels/${identity.channelId}/overlay`,
        ...(account ? { connectedAccount: { login: account.login, displayName: account.displayName } } : {}),
      });
      if (req.path === '/connect' && req.method === 'POST') {
        if (identity.role !== 'broadcaster') throw new HostError(403, 'Only the broadcaster can connect this channel account.');
        if (!oauth) throw new HostError(503, 'The operator must configure the Twitch OAuth app before channels can connect.');
        return res.json({ url: oauth.begin(identity.channelId) });
      }
      if (req.path === '/connection' && req.method === 'DELETE') {
        if (identity.role !== 'broadcaster') throw new HostError(403, 'Only the broadcaster can disconnect this channel account.');
        if (oauth) await oauth.disconnect(identity.channelId);
        return res.json({ ok: true });
      }
      if (req.path === '/configure' && req.method === 'POST') {
        if (identity.role !== 'broadcaster') throw new HostError(403, 'Only the broadcaster can finish channel configuration.');
        if (!account) throw new HostError(409, 'Connect the channel account before finishing setup.');
        entry.store.update(data => { data.extensionConfigured = true; }); entry.runtime.notify();
        return res.json({ configured: true });
      }
      if (req.path === '/data' && req.method === 'DELETE') {
        if (identity.role !== 'broadcaster' || req.body?.confirm !== 'DELETE') throw new HostError(403, 'The broadcaster must explicitly confirm deletion.');
        if (oauth) await oauth.disconnect(identity.channelId);
        entry.runtime.close(); entry.store.close(); channels.delete(identity.channelId);
        for (const suffix of ['', '-wal', '-shm']) rmSync(join(directory, `${identity.channelId}.sqlite${suffix}`), { force: true });
        return res.json({ ok: true });
      }
      const route = req.path;
      const publicRead = req.method === 'GET' && ['/state', '/catchup'].includes(route);
      const vote = req.method === 'POST' && /^\/lore\/[^/]+\/vote$/.test(route);
      const modRoute = /^\/mod\//.test(route);
      if (!publicRead && !vote && !modRoute) throw new HostError(404, 'Extension route not found.');
      if (vote && !identity.opaqueUserId.startsWith('U')) throw new HostError(403, 'Log in to Twitch to vote. Anonymous sessions are never stored.');
      if (modRoute && (!creatorRole || !identityLinked)) throw new HostError(403, 'Share your Twitch identity as the broadcaster or a moderator to edit this channel.');
      if (modRoute && req.method !== 'GET') {
        if (!oauth || !account) throw new HostError(409, 'Connect the channel account before publishing or moderating from the Extension.');
        authors.set(req, await oauth.resolveUser(identity.channelId, identity.userId!));
      }
      const original = req.url;
      req.url = `/api${req.url}`;
      entry.runtime.app(req, res, error => { req.url = original; next(error); });
    } catch (error) { next(error); }
  });

  router.use('/channels/:channelId', (req, res, next) => {
    try {
      const id = String(req.params.channelId);
      const entry = channel(id, false);
      if (req.path.startsWith('/api/')) {
        const publicPaths = ['/api/state', '/api/catchup', '/api/events', '/api/auth/session', '/api/health'];
        if (req.method !== 'GET' || !publicPaths.includes(req.path)) throw new HostError(403, 'Use the Twitch Extension to manage or vote on this channel.');
        return entry.runtime.app(req, res, next);
      }
      if (!['/', '/overlay'].includes(req.path)) return next();
      const filename = resolve('dist/index.html');
      if (!existsSync(filename)) throw new HostError(503, 'Build the companion frontend before serving channel pages.');
      res.sendFile(filename);
    } catch (error) { next(error); }
  });
  router.use((error: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof ExtensionAuthError ? 401 : error instanceof HostError ? error.status : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 502;
    res.status(status).json({ error: status === 502 ? 'The Twitch service could not complete this request. Reconnect or try again.' : error.message });
  });
  return {
    router, installStatus,
    close() { closed = true; for (const entry of channels.values()) { entry.chat?.close(); entry.runtime.close(); entry.store.close(); } channels.clear(); oauth?.close(); },
  };
}
