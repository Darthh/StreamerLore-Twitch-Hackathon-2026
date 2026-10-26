import { createApp } from './app.ts';
import { createStore } from './store.ts';
import { startTwitch } from './twitch.ts';

try { process.loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const mode = process.env.STREAMLORE_MODE ?? 'demo';
if (mode !== 'demo' && mode !== 'live') throw new Error('STREAMLORE_MODE must be demo or live.');
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const store = createStore(process.env.STREAMLORE_DB_PATH || `data/${mode}.sqlite`, mode === 'demo');
const runtime = createApp({ store, mode, password: process.env.STREAMLORE_MOD_PASSWORD, publicUrl: process.env.STREAMLORE_PUBLIC_URL || 'http://localhost:5173' });
const twitch = mode === 'live' ? startTwitch({
  onChat: runtime.ingestChat, onStatus: runtime.setTwitchStatus, onChannel: runtime.setChannel,
  getCatchup: runtime.catchup, getLore: runtime.loreReply, voteLore: runtime.voteLore,
}) : null;
const server = runtime.app.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`StreamLore API: http://${process.env.HOST || '127.0.0.1'}:${port} (${mode} mode)`);
  if (mode === 'demo') console.log('Fictional demo history is enabled. Live Twitch is disconnected.');
});
let closing = false;
function close() {
  if (closing) return; closing = true;
  twitch?.close(); runtime.close(); server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', close); process.on('SIGINT', close);
