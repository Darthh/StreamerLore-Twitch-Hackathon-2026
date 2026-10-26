import WebSocket from 'ws';
import type { Connection, StreamState } from '../shared/types.ts';

type TwitchOptions = {
  onChat: (user: string, text: string) => void;
  onStatus: (status: Connection) => void;
  getCatchup: () => string;
  getLore: (query: string) => string;
  voteLore?: (query: string, user: string) => string;
  onChannel?: (channel: StreamState['channel']) => void;
};

export function parseCommand(text: string): { name: 'catchup' | 'lore' | 'lorevote'; query: string } | null {
  const match = text.trim().match(/^!(catchup|lore|lorevote)(?:\s+(.{0,200}))?$/i);
  return match ? { name: match[1].toLowerCase() as 'catchup' | 'lore' | 'lorevote', query: (match[2] || '').trim() } : null;
}

export function chatReply(command: { name: 'catchup' | 'lore'; query: string }, options: Pick<TwitchOptions, 'getCatchup' | 'getLore'>, publicUrl: string): string {
  const text = command.name === 'catchup' ? options.getCatchup() : options.getLore(command.query);
  const cleaned = text.replace(/[\r\n]+/g, ' ');
  const sourceLink = cleaned.match(/https?:\/\/\S+$/)?.[0];
  const link = sourceLink || (/^https?:\/\//.test(publicUrl) ? publicUrl.replace(/\/$/, '') : '');
  const suffix = link ? ` · ${link}` : '';
  const body = sourceLink ? cleaned.slice(0, -sourceLink.length).trim() : cleaned;
  return `${body.slice(0, Math.max(0, 490 - suffix.length))}${suffix}`.slice(0, 500);
}

export function startTwitch(options: TwitchOptions): { close: () => void } {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const token = process.env.TWITCH_ACCESS_TOKEN?.trim().replace(/^oauth:/, '');
  const channelLogin = process.env.TWITCH_CHANNEL?.trim().replace(/^@|^#/, '').toLowerCase();
  const publicUrl = process.env.STREAMLORE_PUBLIC_URL || '';
  const configured = Boolean(clientId && token && channelLogin);
  const status = (connected: boolean, message: string) => options.onStatus({ configured, connected, message });
  if (!configured) {
    status(false, 'Twitch is not connected. Add your channel, client ID, and user access token.');
    return { close() {} };
  }
  let stopped = false;
  let socket: WebSocket | null = null;
  const sockets = new Set<WebSocket>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let validationTimer: ReturnType<typeof setInterval> | undefined;
  let channelTimer: ReturnType<typeof setInterval> | undefined;
  let botId = '', broadcasterId = '', broadcasterName = channelLogin!, attempts = 0, lastReply = 0;
  const seen = new Set<string>();
  const headers = { Authorization: `Bearer ${token}`, 'Client-Id': clientId! };
  class TwitchError extends Error { code: number; constructor(code: number, message: string) { super(message); this.code = code; } }

  async function request(url: string, init: RequestInit = {}) {
    let response: Response;
    try { response = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(9000) }); }
    catch { throw new Error('Twitch could not be reached. Reconnecting shortly.'); }
    if (!response.ok) {
      if (response.status === 401) throw new TwitchError(401, 'Twitch authorization expired or was revoked. Replace TWITCH_ACCESS_TOKEN and restart.');
      if (response.status === 403) throw new TwitchError(403, 'Twitch denied access. Check chat scopes and channel permissions.');
      throw new TwitchError(response.status, `Twitch request failed (${response.status}). Reconnecting shortly.`);
    }
    return response.status === 204 ? {} : await response.json();
  }

  function close() {
    stopped = true;
    clearTimeout(retry); clearInterval(validationTimer); clearInterval(channelTimer);
    for (const current of sockets) current.terminate();
    sockets.clear(); socket = null;
  }

  function fail(error: unknown) {
    if (stopped) return;
    status(false, error instanceof Error ? error.message : 'Twitch disconnected.');
    if (error instanceof TwitchError && (error.code === 401 || error.code === 403)) close();
  }

  async function validate() {
    const data = await request('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token}` } });
    if (!data.user_id || data.client_id !== clientId) throw new TwitchError(401, 'Use a Twitch user access token issued for TWITCH_CLIENT_ID.');
    if (!Array.isArray(data.scopes) || !['user:read:chat', 'user:write:chat'].every(scope => data.scopes.includes(scope))) {
      throw new TwitchError(403, 'Twitch token needs user:read:chat and user:write:chat scopes.');
    }
    botId = data.user_id;
  }

  async function refreshChannel() {
    const [streams, channels] = await Promise.all([
      request(`https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(broadcasterId)}`),
      request(`https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(broadcasterId)}`),
    ]);
    if (stopped) return;
    const stream = streams.data?.[0], channel = channels.data?.[0];
    options.onChannel?.({ login: channelLogin!, displayName: broadcasterName, category: stream?.game_name || channel?.game_name || '', title: stream?.title || channel?.title || '', live: Boolean(stream), startedAt: stream?.started_at || '' });
  }

  function scheduleReconnect() {
    if (stopped || retry) return;
    status(false, 'Twitch disconnected. Reconnecting…');
    retry = setTimeout(() => { retry = undefined; connect(); }, Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)));
    retry.unref();
  }

  function connect(url = 'wss://eventsub.wss.twitch.tv/ws', previous: WebSocket | null = null) {
    if (stopped) return;
    const current = new WebSocket(url);
    sockets.add(current);
    if (!previous) socket = current;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let keepaliveSeconds = 10;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => current.terminate(), (keepaliveSeconds + 5) * 1000);
      watchdog.unref();
    };
    armWatchdog();
    current.on('message', data => {
      void (async () => {
        if (stopped) return;
        let message;
        try { message = JSON.parse(data.toString()); } catch { return; }
        const type = message.metadata?.message_type;
        armWatchdog();
        if (type === 'session_welcome') {
          keepaliveSeconds = message.payload?.session?.keepalive_timeout_seconds || 10;
          armWatchdog();
          if (!previous) {
            await request('https://api.twitch.tv/helix/eventsub/subscriptions', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: broadcasterId, user_id: botId }, transport: { method: 'websocket', session_id: message.payload.session.id } }),
            });
          }
          if (stopped) return;
          socket = current; attempts = 0;
          clearTimeout(retry); retry = undefined;
          if (previous) previous.close();
          status(true, `Connected to ${broadcasterName} chat. !catchup and !lore are ready.`);
        } else if (type === 'session_reconnect') {
          const reconnectUrl = message.payload?.session?.reconnect_url;
          if (typeof reconnectUrl === 'string' && new URL(reconnectUrl).hostname === 'eventsub.wss.twitch.tv' && reconnectUrl.startsWith('wss://')) connect(reconnectUrl, current);
        } else if (type === 'revocation') {
          fail(new TwitchError(403, 'Twitch chat authorization was revoked. Reauthorize the account and restart.'));
        } else if (type === 'notification' && message.metadata?.subscription_type === 'channel.chat.message') {
          const id = message.metadata?.message_id;
          if (typeof id !== 'string' || seen.has(id)) return;
          seen.add(id);
          if (seen.size > 2000) seen.delete(seen.values().next().value!);
          const event = message.payload?.event;
          if (!event || event.broadcaster_user_id !== broadcasterId || typeof event.message?.text !== 'string') return;
          // Shared-chat copies are not evidence from this channel's own community.
          if (event.source_broadcaster_user_id && event.source_broadcaster_user_id !== broadcasterId) return;
          const text = event.message.text.slice(0, 500);
          const command = parseCommand(text);
          if (event.chatter_user_id !== botId) options.onChat(String(event.chatter_user_name || event.chatter_user_login || 'Viewer').slice(0, 80), text);
          // Count every viewer's vote; only the outgoing acknowledgement is throttled.
          const voteReply = command?.name === 'lorevote'
            ? options.voteLore?.(command.query, String(event.chatter_user_id || '')) || 'Community voting is not available right now.'
            : null;
          if (!command || Date.now() - lastReply < 3000) return;
          lastReply = Date.now();
          const reply = command.name === 'lorevote'
            ? voteReply!.replace(/[\r\n]+/g, ' ').slice(0, 500)
            : chatReply(command as { name: 'catchup' | 'lore'; query: string }, options, publicUrl);
          const sent = await request('https://api.twitch.tv/helix/chat/messages', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: botId, message: reply, reply_parent_message_id: event.message_id }),
          });
          if (sent.data?.[0]?.is_sent === false) status(true, 'Reading chat; Twitch blocked a command reply. Check channel chat restrictions.');
        }
      })().catch(error => { fail(error); if (!stopped && current === socket) current.terminate(); });
    });
    current.on('error', () => { if (!stopped && current === socket) status(false, 'Twitch connection failed. Reconnecting…'); });
    current.on('close', () => {
      clearTimeout(watchdog); sockets.delete(current);
      if (stopped) return;
      if (current === socket) { socket = null; scheduleReconnect(); }
      else if (previous && previous.readyState !== WebSocket.OPEN) scheduleReconnect();
    });
  }

  status(false, 'Connecting to Twitch…');
  void (async () => {
    await validate();
    const users = await request(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelLogin!)}`);
    if (!users.data?.[0]?.id) throw new TwitchError(403, 'TWITCH_CHANNEL was not found. Use the channel login without a URL.');
    broadcasterId = users.data[0].id; broadcasterName = users.data[0].display_name;
    if (stopped) return;
    // Opening the socket first leaves its ten-second subscription deadline free of lookup requests.
    connect();
    void refreshChannel().catch(fail);
    validationTimer = setInterval(() => { void validate().catch(fail); }, 60 * 60 * 1000);
    channelTimer = setInterval(() => { void refreshChannel().catch(fail); }, 60_000);
    validationTimer.unref(); channelTimer.unref();
  })().catch(error => { fail(error); if (!stopped) status(false, 'Could not initialize Twitch. Check credentials/network and restart.'); });
  return { close };
}
