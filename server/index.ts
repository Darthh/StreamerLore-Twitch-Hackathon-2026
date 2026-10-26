import { createApp } from './app.ts';
import { createStore } from './store.ts';
import { startTwitch } from './twitch.ts';
import express from 'express';
import { resolve } from 'node:path';
import { createExtensionHost } from './extension-host.ts';

try { process.loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const mode = process.env.STREAMLORE_MODE ?? 'demo';
if (mode !== 'demo' && mode !== 'live' && mode !== 'extension') throw new Error('STREAMLORE_MODE must be demo, live, or extension.');
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const publicUrl = process.env.STREAMLORE_PUBLIC_URL || 'http://localhost:5173';
const oauthConfigured = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'STREAMLORE_TOKEN_ENCRYPTION_KEY'].every(name => Boolean(process.env[name]?.trim()));
const extension = createExtensionHost({
  clientId: process.env.TWITCH_EXTENSION_CLIENT_ID, secret: process.env.TWITCH_EXTENSION_SECRET, publicUrl,
  dataDirectory: process.env.STREAMLORE_EXTENSION_DATA_DIR,
  localTest: process.env.STREAMLORE_EXTENSION_LOCAL_TEST === 'true',
  extraOrigins: process.env.STREAMLORE_EXTENSION_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean),
  maxChannels: process.env.STREAMLORE_MAX_CHANNELS ? Number(process.env.STREAMLORE_MAX_CHANNELS) : undefined,
  released: process.env.TWITCH_EXTENSION_RELEASED === 'true', installUrl: process.env.TWITCH_EXTENSION_INSTALL_URL,
  demoPreview: mode === 'demo',
  ...(oauthConfigured ? { oauth: { clientId: process.env.TWITCH_CLIENT_ID!, clientSecret: process.env.TWITCH_CLIENT_SECRET!, encryptionKey: process.env.STREAMLORE_TOKEN_ENCRYPTION_KEY!, redirectUri: process.env.TWITCH_OAUTH_REDIRECT_URI || `${publicUrl.replace(/\/$/, '')}/auth/twitch/callback` } } : {}),
});
const app = express();
app.disable('x-powered-by'); app.use(extension.router);
const store = mode !== 'extension' ? createStore(process.env.STREAMLORE_DB_PATH || `data/${mode}.sqlite`, mode === 'demo') : null;
const runtime = store && mode !== 'extension' ? createApp({ store, mode, password: process.env.STREAMLORE_MOD_PASSWORD, publicUrl }) : null;
const twitch = mode === 'live' && runtime ? startTwitch({ onChat: runtime.ingestChat, onStatus: runtime.setTwitchStatus, onChannel: runtime.setChannel, getCatchup: runtime.catchup, getLore: runtime.loreReply, voteLore: runtime.voteLore }) : null;
if (runtime) app.use(runtime.app);
else {
  app.get('/', (_req, res) => res.redirect('/install'));
  app.get('/api/health', (_req, res) => res.json({ ok: true, mode }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Use the Twitch Extension for channel access.' }));
  app.use(express.static(resolve('dist')));
}
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`StreamLore API: http://${process.env.HOST || '127.0.0.1'}:${port} (${mode} mode)`);
  if (mode === 'demo') console.log('Fictional demo history is enabled. Live Twitch is disconnected.');
  console.log(`Native Twitch setup: ${publicUrl.replace(/\/$/, '')}/install`);
});
let closing = false;
function close() {
  if (closing) return; closing = true;
  twitch?.close(); runtime?.close(); extension.close(); server.close(() => { store?.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', close); process.on('SIGINT', close);
