import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connection, ContentAuthor, Lore, LoreCategory, StreamState } from '../shared/types.ts';
import type { Store } from './store.ts';
import { advanceDemo } from './seed.ts';
import { aiConfigured, draftLore, summarizeStream } from './ai.ts';
import { answerLoreQuestion } from '../shared/lore.ts';

const categories: LoreCategory[] = ['Inside joke', 'Tradition', 'Character', 'Moment'];
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function text(value: unknown, name: string, max: number, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new HttpError(400, `${name} must be ${required ? '1' : '0'}–${max} characters.`);
  return value.trim();
}
export function clipUrl(value: unknown): string {
  const raw = text(value, 'Clip URL', 2048, false);
  if (!raw) return '';
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'Enter a valid Twitch clip URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !(
    (url.hostname === 'clips.twitch.tv' && url.pathname.length > 1) ||
    (['twitch.tv', 'www.twitch.tv'].includes(url.hostname) && /^\/[^/]+\/clip\/[^/]+\/?$/.test(url.pathname))
  )) throw new HttpError(400, 'Use an HTTPS Twitch clip link.');
  return url.href;
}
function loreFields(body: Record<string, unknown>, partial = false): Partial<Lore> {
  const fields: Partial<Lore> = {};
  for (const [key, max] of [['term', 80], ['explanation', 1400], ['origin', 2000]] as const) {
    if (!partial || body[key] !== undefined) fields[key] = text(body[key], key, max);
  }
  if (!partial || body.clipUrl !== undefined) fields.clipUrl = clipUrl(body.clipUrl);
  if (!partial || body.aliases !== undefined) {
    if (body.aliases !== undefined && (!Array.isArray(body.aliases) || body.aliases.length > 10)) throw new HttpError(400, 'Use at most 10 aliases.');
    fields.aliases = [...new Set(((body.aliases ?? []) as unknown[]).map(alias => text(alias, 'Alias', 80)))];
  }
  if (!partial || body.category !== undefined) {
    if (!categories.includes(body.category as LoreCategory)) throw new HttpError(400, 'Choose a valid lore category.');
    fields.category = body.category as LoreCategory;
  }
  if (body.status !== undefined) {
    if (!['pending', 'nominated', 'approved', 'rejected'].includes(body.status as string)) throw new HttpError(400, 'Choose a valid review status.');
    fields.status = body.status as Lore['status'];
  }
  return fields;
}
function cookies(req: Request): Record<string, string> {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=')).filter(pair => pair.length === 2));
}
function local(req: Request) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? ''); }
const digest = (value: string) => createHash('sha256').update(value).digest();

export function createApp({ store, mode = 'demo', password = '', publicUrl = 'http://localhost:5173', authorizeModerator, trustedRequest, voterIdentity, contentAuthor, extensionManaged = false, staticFiles = true }: {
  store: Store; mode?: 'demo' | 'live'; password?: string; publicUrl?: string;
  authorizeModerator?: (req: Request) => boolean; trustedRequest?: (req: Request) => boolean;
  voterIdentity?: (req: Request) => string | undefined; contentAuthor?: (req: Request) => ContentAuthor | undefined;
  extensionManaged?: boolean; staticFiles?: boolean;
}) {
  const demo = mode === 'demo';
  if (!demo && !authorizeModerator && password.length < 12) throw new Error('Set STREAMLORE_MOD_PASSWORD to at least 12 characters before starting live mode.');
  const parsedPublicUrl = new URL(publicUrl);
  if (!['http:', 'https:'].includes(parsedPublicUrl.protocol) || parsedPublicUrl.username || parsedPublicUrl.password) throw new Error('STREAMLORE_PUBLIC_URL must be a public HTTP(S) URL without credentials.');
  publicUrl = publicUrl.replace(/\/$/, '');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '80kb', strict: true }));
  const secret = store.cookieSecret;
  const sessions = new Map<string, number>();
  const clients = new Set<Response>();
  const limits = new Map<string, { at: number; count: number }>();
  let twitch: Connection = { configured: false, connected: false, message: demo ? 'Demo channel · live connection off' : 'Waiting for Twitch configuration' };
  let aiBusy = false;
  let aiVerified = false;
  let dropTimer: ReturnType<typeof setTimeout> | undefined;
  if (store.read().loreDropId) store.update(data => { data.loreDropId = null; });
  const authenticated = (req: Request) => {
    if (authorizeModerator) return authorizeModerator(req);
    if (demo && local(req)) return true;
    const token = cookies(req).streamlore_session;
    const expiry = token && sessions.get(token);
    if (expiry && expiry > Date.now()) return true;
    if (token) sessions.delete(token);
    return false;
  };
  function state(): StreamState {
    const data = store.read();
    const approved = data.lore.filter(entry => entry.status === 'approved');
    return {
      mode, channel: data.channel, stream: data.stream, moments: data.moments, lore: approved,
      nominations: data.lore.filter(entry => entry.status === 'nominated'),
      loreDrop: approved.find(entry => entry.id === data.loreDropId) ?? null,
      stats: { moments: data.moments.length, lore: approved.length, pending: data.lore.filter(entry => entry.status === 'pending').length },
      connection: { twitch, ai: { configured: aiConfigured(), connected: aiVerified, message: aiConfigured() ? (aiVerified ? 'AI drafting connected · moderator review required' : 'AI configured · awaiting first request') : 'AI not connected · moderator notes available' } },
    };
  }
  function broadcast() { const event = `event: state\ndata: ${JSON.stringify(state())}\n\n`; clients.forEach(res => res.write(event)); }
  function expireDrop() {
    clearTimeout(dropTimer);
    dropTimer = setTimeout(() => { store.update(data => { data.loreDropId = null; }); broadcast(); }, 18_000);
    dropTimer.unref();
  }
  function rateLimit(req: Request, key: string, max: number, windowMs: number) {
    const id = `${key}:${voterIdentity?.(req) || req.socket.remoteAddress}`;
    const now = Date.now();
    for (const [key, item] of limits) if (now - item.at > 3_600_000) limits.delete(key);
    let entry = limits.get(id);
    if (!entry || now - entry.at >= windowMs) { entry = { at: now, count: 0 }; limits.set(id, entry); }
    if (++entry.count > max) throw new HttpError(429, 'Too many requests. Give it a moment and try again.');
  }
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ error: 'Send a JSON object.' });
      req.body ??= {};
      const origin = req.headers.origin;
      if (origin && !trustedRequest?.(req)) {
        let host: string;
        try { host = new URL(origin).host; } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
        if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site changes are not allowed.' });
      }
      if (req.headers['sec-fetch-site'] === 'cross-site' && !trustedRequest?.(req)) return res.status(403).json({ error: 'Cross-site changes are not allowed.' });
      try { rateLimit(req, 'writes', 90, 60_000); } catch (error) { return next(error); }
    }
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, mode }));
  app.get('/api/state', (_req, res) => res.json(state()));
  app.get('/api/auth/session', (req, res) => res.json({ authenticated: authenticated(req), demoAccess: demo && local(req), ...(extensionManaged ? { extensionManaged: true } : {}) }));
  app.post('/api/auth/login', (req, res) => {
    rateLimit(req, 'login', 8, 15 * 60_000);
    const supplied = text(req.body.password, 'Password', 256);
    if (!password || !timingSafeEqual(digest(supplied), digest(password))) throw new HttpError(401, 'That moderator password is not correct.');
    for (const [token, expiry] of sessions) if (expiry < Date.now()) sessions.delete(token);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + 12 * 3_600_000);
    res.cookie('streamlore_session', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 12 * 3_600_000 });
    res.json({ authenticated: true, demoAccess: false });
  });
  app.post('/api/auth/logout', (req, res) => { sessions.delete(cookies(req).streamlore_session); res.clearCookie('streamlore_session'); res.json({ ok: true }); });
  app.get('/api/events', (req, res) => {
    if (clients.size >= 200) return res.status(503).json({ error: 'The event stream is full. Refresh to try again.' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders(); clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 25_000);
    req.on('close', () => { clients.delete(res); clearInterval(keepAlive); });
  });
  function catchup() {
    const data = store.read();
    const summary = data.stream.summary.length ? data.stream.summary.join(' ') : 'No recap has been published yet.';
    return `${summary} Catch up + channel lore: ${publicUrl}`;
  }
  function findLore(query: string, nominated = false) {
    const entries = store.read().lore.filter(item => nominated ? item.status === 'nominated' : item.status === 'approved');
    const q = query.toLocaleLowerCase().trim();
    return entries.find(item => [item.term, ...item.aliases].some(term => term.toLocaleLowerCase() === q)) ?? entries.find(item => q.length >= 2 && [item.term, ...item.aliases].some(term => term.toLocaleLowerCase().includes(q)));
  }
  function loreReply(query: string) {
    if (!query.trim()) return `Explore the channel’s lore: ${store.read().lore.filter(item => item.status === 'approved').slice(0, 3).map(item => item.term).join(', ') || 'No approved entries yet'}. Try !lore <term> · ${publicUrl}?view=lore`;
    const item = answerLoreQuestion(store.read().lore, query) ?? findLore(query);
    if (!item) return `No approved lore found for “${query.slice(0, 60)}”. Explore ${publicUrl}?view=lore`;
    return `${item.term}: ${item.explanation} ${item.clipUrl || `${publicUrl}?lore=${encodeURIComponent(item.id)}`}`;
  }
  app.get('/api/catchup', (_req, res) => res.json({ text: catchup(), summary: store.read().stream.summary }));
  app.post('/api/lore/:id/vote', (req, res) => {
    const stored = cookies(req).streamlore_voter;
    const [id = '', signature = ''] = (stored || '').split('.');
    const sign = (value: string) => createHmac('sha256', secret).update(value).digest('hex');
    const externalVoter = voterIdentity?.(req);
    let voter = id;
    if (!externalVoter && (!/^[a-f0-9]{32}$/.test(id) || signature !== sign(id))) {
      voter = randomBytes(16).toString('hex');
      res.cookie('streamlore_voter', `${voter}.${sign(voter)}`, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 365 * 86_400_000 });
    }
    const result = store.vote(String(req.params.id), externalVoter || `browser:${voter}`);
    if (result.error) return res.status(result.status!).json({ error: result.error });
    broadcast(); res.json(result.entry);
  });
  app.use(['/api/mod', '/api/demo'], (req, res, next) => authenticated(req) ? next() : res.status(401).json({ error: 'Sign in as a moderator to make changes.' }));
  app.get('/api/mod/state', (_req, res) => {
    const data = store.read();
    res.json({ pending: data.lore.filter(item => item.status === 'pending'), rejected: data.lore.filter(item => item.status === 'rejected'), captions: data.captions, chat: data.chat.slice(-100) });
  });
  app.post('/api/mod/objective', (req, res) => {
    const objective = text(req.body.objective, 'Objective', 300);
    store.update(data => { data.stream.objective = objective; data.stream.updatedAt = new Date().toISOString(); });
    broadcast(); res.json(state());
  });
  app.post('/api/mod/moments', (req, res) => {
    const title = text(req.body.title, 'Title', 120); const body = text(req.body.body, 'Description', 1400);
    const kind = req.body.kind;
    if (!['milestone', 'setback', 'highlight', 'context'].includes(kind)) throw new HttpError(400, 'Choose a valid moment type.');
    const url = clipUrl(req.body.clipUrl);
    store.update(data => {
      data.moments.unshift({ id: randomUUID(), title, body, kind, at: new Date().toISOString(), offsetSeconds: Math.max(0, Math.floor((Date.now() - (Date.parse(data.channel.startedAt) || Date.now())) / 1000)), source: 'moderator', clipUrl: url, ...(contentAuthor?.(req) ? { author: contentAuthor(req) } : {}) });
      data.moments = data.moments.slice(0, 300);
      data.stream.summary = data.moments.slice(0, 3).map(item => `${item.title}: ${item.body}`);
      data.stream.updatedAt = new Date().toISOString();
    });
    broadcast(); res.status(201).json(state());
  });
  app.delete('/api/mod/moments/:id', (req, res) => {
    store.update(data => {
      if (!data.moments.some(item => item.id === req.params.id)) throw new HttpError(404, 'Moment not found.');
      data.moments = data.moments.filter(item => item.id !== req.params.id);
      data.stream.summary = data.moments.slice(0, 3).map(item => `${item.title}: ${item.body}`);
      data.stream.updatedAt = new Date().toISOString();
    });
    broadcast(); res.json(state());
  });
  app.post('/api/mod/lore', (req, res) => {
    const fields = loreFields(req.body);
    const item = { ...fields, id: randomUUID(), status: 'pending', votes: 0, source: 'moderator', createdAt: new Date().toISOString(), ...(contentAuthor?.(req) ? { author: contentAuthor(req) } : {}) } as Lore;
    store.update(data => {
      if (data.lore.length >= 1000) throw new HttpError(409, 'The library is full. Review existing entries first.');
      if (data.lore.some(entry => entry.status !== 'rejected' && entry.term.toLowerCase() === item.term.toLowerCase())) throw new HttpError(409, 'That term already has a lore entry. Edit the existing one.');
      data.lore.unshift(item);
    });
    broadcast(); res.status(201).json(item);
  });
  app.patch('/api/mod/lore/:id', (req, res) => {
    const fields = loreFields(req.body, true);
    if (!Object.keys(fields).length) throw new HttpError(400, 'No changes were supplied.');
    let updated: Lore | undefined;
    store.update(data => {
      const item = data.lore.find(entry => entry.id === req.params.id);
      if (!item) throw new HttpError(404, 'Lore entry not found.');
      if (fields.term && data.lore.some(entry => entry.id !== item.id && entry.status !== 'rejected' && entry.term.toLowerCase() === fields.term!.toLowerCase())) throw new HttpError(409, 'That term already has a lore entry.');
      Object.assign(item, fields); updated = item;
      if (fields.status && ['approved', 'nominated'].includes(fields.status) && contentAuthor?.(req)) item.reviewedBy = contentAuthor(req);
      if (item.status !== 'approved' && data.loreDropId === item.id) data.loreDropId = null;
    });
    broadcast(); res.json(updated);
  });
  app.post('/api/mod/lore/:id/drop', (req, res) => {
    const item = store.read().lore.find(entry => entry.id === req.params.id && entry.status === 'approved');
    if (!item) throw new HttpError(404, 'Only approved lore can appear on stream.');
    store.update(data => { data.loreDropId = item.id; }); expireDrop(); broadcast(); res.json(item);
  });
  app.delete('/api/mod/drop', (_req, res) => { clearTimeout(dropTimer); store.update(data => { data.loreDropId = null; }); broadcast(); res.json({ ok: true }); });
  async function generateDrafts(captions: string, clips: { url: string; title: string; transcript: string }[] = []) {
    if (aiBusy) throw new HttpError(409, 'An AI request is already in progress.');
    if (!aiConfigured()) throw new HttpError(503, 'AI is not connected. Add OPENAI_API_KEY to .env, or write a moderator entry.');
    aiBusy = true;
    try {
      const current = store.read();
      const drafts = await draftLore({ captions, chat: current.chat.slice(-100), existingTerms: current.lore.filter(item => item.status !== 'rejected').map(item => item.term), clips });
      aiVerified = true;
      if (store.read().channel.startedAt !== current.channel.startedAt) throw new HttpError(409, 'A new stream started while drafting. Submit the current stream’s context again.');
      let count = 0;
      store.update(data => {
        data.captions = captions;
        for (const draft of drafts) {
          if (data.lore.length >= 1000) break;
          if (data.lore.some(item => item.term.toLowerCase() === draft.term.toLowerCase() && item.status !== 'rejected')) continue;
          const fields = loreFields(draft);
          data.lore.unshift({ ...fields, id: randomUUID(), status: 'pending', votes: 0, source: 'ai', createdAt: new Date().toISOString() } as Lore); count++;
        }
      });
      broadcast(); return count;
    } finally { aiBusy = false; }
  }
  app.post('/api/mod/draft', async (req, res) => {
    rateLimit(req, 'ai', 20, 3_600_000);
    const captions = text(req.body.captions, 'Captions', 30_000, false);
    const clips: { url: string; title: string; transcript: string }[] = [];
    if (req.body.clipUrl) clips.push({ url: clipUrl(req.body.clipUrl), title: text(req.body.clipTitle || 'Clip supplied by moderator', 'Clip title', 200), transcript: text(req.body.clipTranscript, 'Clip transcript', 15_000) });
    if (!captions && !clips.length && store.read().chat.length < 3) throw new HttpError(400, 'Add captions, a clip transcript, or a few live chat messages first.');
    try {
      const count = await generateDrafts(captions, clips);
      res.json({ count, message: count ? `${count} draft${count === 1 ? '' : 's'} saved for moderator review.` : 'No new lore was supported by this context. Add a clear explanation or origin transcript.' });
    }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, error instanceof Error ? error.message : 'AI drafting failed. Try again.'); }
  });
  app.post('/api/mod/recap', async (req, res) => {
    rateLimit(req, 'ai', 20, 3_600_000);
    if (!aiConfigured()) throw new HttpError(503, 'AI is not connected. Add OPENAI_API_KEY to .env. Recaps from moderator notes still work.');
    if (aiBusy) throw new HttpError(409, 'An AI request is already in progress.');
    const captions = text(req.body.captions, 'Captions', 30_000, false);
    const current = store.read();
    if (!current.moments.length && !captions) throw new HttpError(400, 'Add a moment or captions before generating a recap.');
    aiBusy = true;
    try {
      const summary = await summarizeStream({ objective: current.stream.objective, moments: current.moments.slice(0, 15), captions });
      aiVerified = true;
      const latest = store.read();
      if (latest.channel.startedAt !== current.channel.startedAt || latest.stream.updatedAt !== current.stream.updatedAt) throw new HttpError(409, 'The stream context changed while drafting. Generate a fresh recap.');
      store.update(data => { data.stream.summary = summary; data.stream.updatedAt = new Date().toISOString(); data.captions = captions; });
      broadcast(); res.json(state());
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, error instanceof Error ? error.message : 'AI recap failed.'); }
    finally { aiBusy = false; }
  });
  app.post('/api/demo/advance', (_req, res) => { if (!demo) throw new HttpError(403, 'Demo controls are disabled in live mode.'); store.update(advanceDemo); if (store.read().loreDropId) expireDrop(); broadcast(); res.json(state()); });
  app.post('/api/demo/reset', (_req, res) => { if (!demo) throw new HttpError(403, 'Demo controls are disabled in live mode.'); clearTimeout(dropTimer); store.reset(); broadcast(); res.json(state()); });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  const dist = resolve('dist');
  if (staticFiles && existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  app.use((error: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof HttpError ? error.status : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error('StreamLore request failed:', error.message);
    res.status(status).json({ error: status === 500 ? 'Something went wrong. Your change was not completed.' : status === 400 && error instanceof SyntaxError ? 'Send a valid JSON request.' : error.message });
  });
  let spikeAt = 0;
  let lastDropAt = 0;
  return {
    app, state, catchup, loreReply, notify: broadcast,
    setTwitchStatus(status: Connection) { twitch = status; broadcast(); },
    setChannel(channel: StreamState['channel']) {
      store.update(data => {
        const startedAt = Number.isFinite(Date.parse(channel.startedAt)) ? channel.startedAt : data.channel.startedAt;
        const newSession = channel.live && startedAt !== data.channel.startedAt;
        data.channel = { ...channel, startedAt };
        if (newSession) { data.moments = []; data.chat = []; data.captions = ''; data.stream.summary = []; data.stream.objective = 'Set today’s stream objective in the moderator room.'; data.stream.updatedAt = new Date().toISOString(); data.loreDropId = null; }
      }); broadcast();
    },
    voteLore(query: string, user: string) {
      const item = findLore(query, true);
      if (!item) return 'No moderator-approved nomination matches that term. Check the community ballot on StreamLore.';
      const result = store.vote(item.id, `twitch:${user.toLowerCase()}`);
      if (result.error) return result.error;
      broadcast(); return result.entry!.status === 'approved' ? `${item.term} is now part of the channel’s lore! ${publicUrl}?view=lore` : `Vote counted for ${item.term}: ${result.entry!.votes}/5. Mods have approved this nomination.`;
    },
    ingestChat(user: string, raw: string) {
      const message = raw.slice(0, 1000); const now = Date.now();
      store.update(data => { data.chat.push({ user: user.slice(0, 50), text: message, at: new Date(now).toISOString() }); data.chat = data.chat.slice(-200); });
      if (message.startsWith('!')) return;
      const data = store.read();
      const recent = data.chat.filter(line => now - Date.parse(line.at) <= 60_000 && !line.text.startsWith('!'));
      const normalized = ` ${message.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `;
      const recurring = data.lore.find(item => item.status === 'approved' && [item.term, ...item.aliases].some(alias => normalized.includes(` ${alias.toLowerCase()} `)));
      if (recurring && now - lastDropAt > 60_000) {
        const mentions = new Set(recent.filter(line => [recurring.term, ...recurring.aliases].some(alias => ` ${line.text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `.includes(` ${alias.toLowerCase()} `))).map(line => line.user));
        if (mentions.size >= 3) { lastDropAt = now; store.update(draft => { draft.loreDropId = recurring.id; }); expireDrop(); broadcast(); }
      }
      // A burst is a review signal, never evidence for an invented backstory.
      const words = [...new Set(message.toLowerCase().match(/\b[a-z]{4,30}\b/g) ?? [])].filter(word => !['this', 'that', 'with', 'have', 'what', 'just', 'like', 'really', 'there', 'your', 'from', 'will', 'been', 'they', 'when', 'stream'].includes(word));
      const spike = words.some(word => new Set(recent.filter(line => new RegExp(`\\b${word}\\b`, 'i').test(line.text)).map(line => line.user)).size >= 5);
      if (spike && aiConfigured() && !aiBusy && now - spikeAt >= 5 * 60_000) {
        spikeAt = now; void generateDrafts(data.captions).catch(error => console.warn('Chat-spike draft unavailable:', error instanceof Error ? error.message : 'request failed'));
      }
    },
    close() { clearTimeout(dropTimer); clients.forEach(client => client.end()); clients.clear(); },
  };
}
