import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, clipUrl } from '../server/app.ts';
import { createStore } from '../server/store.ts';
import type { Lore, StreamState } from '../shared/types.ts';

async function fixture(t: TestContext, live = false) {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const store = createStore(':memory:', !live);
  const runtime = createApp({ store, mode: live ? 'live' : 'demo', password: live ? 'test-password-1234' : '', publicUrl: 'https://streamlore.example' });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    runtime.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
  });
  async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  }
  return { store, runtime, request, base };
}

const newLore = {
  term: 'Moon cheese', aliases: ['cheese'], explanation: 'A name for the round yellow platform.',
  origin: 'The moderator notes explain the nickname; the historical origin is unknown.',
  clipUrl: '', category: 'Inside joke',
};

test('public state and command lookup never expose private pending or rejected lore', async t => {
  const { request, runtime } = await fixture(t);
  const result = await request('/api/state');
  const state = result.data as StreamState;
  assert.equal(result.status, 200);
  assert.ok(state.lore.length > 0);
  assert.ok(state.lore.every(entry => entry.status === 'approved'));
  assert.ok(state.nominations.every(entry => entry.status === 'nominated'));
  assert.ok(!JSON.stringify(state).includes('wall-friend'));
  assert.ok(runtime.loreReply('wall friend').includes('No approved lore'));
  const mod = await request('/api/mod/state');
  assert.ok(mod.data.pending.some((entry: Lore) => entry.id === 'wall-friend'));
  assert.equal((await request('/api/mod/lore/wall-friend', 'PATCH', { status: 'rejected' })).status, 200);
  assert.ok(!(await request('/api/mod/state')).data.pending.some((entry: Lore) => entry.id === 'wall-friend'));
  assert.ok(!(await request('/api/state')).data.lore.some((entry: Lore) => entry.id === 'wall-friend'));
});

test('moderator creates a private entry, edits it, and explicitly publishes it', async t => {
  const { request } = await fixture(t);
  const created = await request('/api/mod/lore', 'POST', newLore);
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'pending');
  assert.ok(!(await request('/api/state')).data.lore.some((entry: Lore) => entry.id === created.data.id));
  const edited = await request(`/api/mod/lore/${created.data.id}`, 'PATCH', { explanation: 'A confirmed, moderator-written explanation.', status: 'approved', clipUrl: 'https://clips.twitch.tv/RealClipIdentifier' });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.explanation, 'A confirmed, moderator-written explanation.');
  assert.ok((await request('/api/state')).data.lore.some((entry: Lore) => entry.id === created.data.id));
  assert.equal((await request('/api/mod/lore', 'POST', { ...newLore, term: 'MOON CHEESE' })).status, 409);
});

test('only reviewed nominations can be voted into the library at five distinct votes', async t => {
  const { request, runtime } = await fixture(t);
  const created = await request('/api/mod/lore', 'POST', newLore);
  const id = created.data.id;
  assert.equal((await request(`/api/lore/${id}/vote`, 'POST')).status, 404);
  assert.equal((await request(`/api/mod/lore/${id}`, 'PATCH', { status: 'nominated' })).status, 200);
  const first = await request(`/api/lore/${id}/vote`, 'POST');
  assert.equal(first.data.votes, 1);
  assert.ok(first.cookie.includes('streamlore_voter='));
  assert.equal((await request(`/api/lore/${id}/vote`, 'POST', undefined, { Cookie: first.cookie })).status, 409);
  assert.ok(runtime.voteLore('moon cheese', 'twitch-user-1').includes('2/5'));
  assert.ok(runtime.voteLore('moon cheese', 'twitch-user-1').includes('already voted'));
  runtime.voteLore('moon cheese', 'twitch-user-2');
  runtime.voteLore('moon cheese', 'twitch-user-3');
  assert.ok(runtime.voteLore('moon cheese', 'twitch-user-4').includes('now part'));
  const state = (await request('/api/state')).data as StreamState;
  assert.equal(state.lore.find(entry => entry.id === id)?.votes, 5);
  assert.ok(!state.nominations.some(entry => entry.id === id));
});

test('field validation rejects unsafe clip URLs, empty terms, invalid categories, and oversized aliases', async t => {
  const { request } = await fixture(t);
  for (const clip of ['javascript:alert(1)', 'http://clips.twitch.tv/Insecure', 'https://clips.twitch.tv.attacker.example/Clip', 'https://www.twitch.tv/settings', 'https://user:password@clips.twitch.tv/Clip']) {
    assert.equal((await request('/api/mod/lore', 'POST', { ...newLore, clipUrl: clip })).status, 400, clip);
  }
  assert.equal((await request('/api/mod/lore', 'POST', { ...newLore, term: '   ' })).status, 400);
  assert.equal((await request('/api/mod/lore', 'POST', { ...newLore, category: 'not-a-category' })).status, 400);
  assert.equal((await request('/api/mod/lore', 'POST', { ...newLore, aliases: Array(11).fill('alias') })).status, 400);
  assert.equal((await request('/api/mod/lore/refrigerator', 'PATCH', { status: 'automatic' })).status, 400);
  assert.equal(clipUrl('https://www.twitch.tv/channel/clip/Identifier'), 'https://www.twitch.tv/channel/clip/Identifier');
  assert.equal(clipUrl(''), '');
});

test('live mode starts empty and requires login for moderator and demo routes', async t => {
  const { request } = await fixture(t, true);
  const state = (await request('/api/state')).data as StreamState;
  assert.equal(state.mode, 'live');
  assert.equal(state.channel.live, false);
  assert.deepEqual(state.moments, []);
  assert.deepEqual(state.lore, []);
  assert.deepEqual(state.nominations, []);
  assert.equal((await request('/api/mod/state')).status, 401);
  assert.equal((await request('/api/mod/objective', 'POST', { objective: 'Should not save' })).status, 401);
  assert.equal((await request('/api/demo/advance', 'POST')).status, 401);
  assert.equal((await request('/api/auth/login', 'POST', { password: 'incorrect-password' })).status, 401);
  const login = await request('/api/auth/login', 'POST', { password: 'test-password-1234' });
  assert.equal(login.status, 200);
  assert.ok(login.cookie.startsWith('streamlore_session='));
  assert.equal((await request('/api/mod/objective', 'POST', { objective: 'A real live objective' }, { Cookie: login.cookie })).status, 200);
  assert.equal((await request('/api/demo/advance', 'POST', undefined, { Cookie: login.cookie })).status, 403);
  assert.equal((await request('/api/auth/logout', 'POST', undefined, { Cookie: login.cookie })).status, 200);
  assert.equal((await request('/api/mod/state', 'GET', undefined, { Cookie: login.cookie })).status, 401);
});

test('cross-site changes are blocked even in local demo mode', async t => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/api/mod/objective', 'POST', { objective: 'Injected' }, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('/api/mod/objective', 'POST', { objective: 'Injected' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('/api/mod/objective', 'POST', { objective: 'Legitimate' }, { Origin: base })).status, 200);
});

test('AI-unavailable responses preserve content and explain the missing connection', async t => {
  const { request } = await fixture(t);
  const before = (await request('/api/state')).data as StreamState;
  const draft = await request('/api/mod/draft', 'POST', { captions: 'Chat explains why this platform is called Moon Cheese.' });
  assert.equal(draft.status, 503);
  assert.match(draft.data.error, /AI is not connected/);
  const recap = await request('/api/mod/recap', 'POST', { captions: 'The streamer reached the summit.' });
  assert.equal(recap.status, 503);
  assert.deepEqual((await request('/api/state')).data.stream.summary, before.stream.summary);
});

test('demo advance changes the catch-up card and overlay; unapproved lore cannot be dropped', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/mod/lore/wall-friend/drop', 'POST')).status, 404);
  const advanced = await request('/api/demo/advance', 'POST');
  assert.equal(advanced.status, 200);
  assert.equal(advanced.data.loreDrop.id, 'refrigerator');
  assert.match(advanced.data.stream.summary[0], /completed/);
  assert.match(advanced.data.moments[0].title, /SUMMIT/);
  assert.equal((await request('/api/mod/drop', 'DELETE')).status, 200);
  assert.equal((await request('/api/state')).data.loreDrop, null);
  await request('/api/mod/lore/refrigerator/drop', 'POST');
  await request('/api/mod/lore/refrigerator', 'PATCH', { status: 'rejected' });
  assert.equal((await request('/api/state')).data.loreDrop, null);
  await request('/api/demo/reset', 'POST');
  const reset = (await request('/api/state')).data as StreamState;
  assert.equal(reset.loreDrop, null);
  assert.match(reset.stream.objective, /without using a single dash/);
});

test('moderator notes become timestamped catch-up moments', async t => {
  const { request } = await fixture(t);
  const result = await request('/api/mod/moments', 'POST', { title: 'A new checkpoint', body: 'The streamer completed the third room.', kind: 'milestone' });
  assert.equal(result.status, 201);
  assert.equal(result.data.moments[0].source, 'moderator');
  assert.ok(Number.isFinite(result.data.moments[0].offsetSeconds));
  assert.match(result.data.stream.summary[0], /A new checkpoint/);
  assert.match((await request('/api/catchup')).data.text, /https:\/\/streamlore.example/);
});

test('lore drop chat trigger requires three different viewers mentioning an approved term', async t => {
  const { runtime } = await fixture(t);
  runtime.ingestChat('same-viewer', 'refrigerator');
  runtime.ingestChat('same-viewer', 'refrigerator');
  runtime.ingestChat('same-viewer', 'refrigerator');
  assert.equal(runtime.state().loreDrop, null);
  runtime.ingestChat('second-viewer', 'refrigerator');
  assert.equal(runtime.state().loreDrop, null);
  runtime.ingestChat('third-viewer', 'refrigerator');
  assert.equal(runtime.state().loreDrop?.id, 'refrigerator');
});

test('SQLite persists edits and vote deduplication across store reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'streamlore-test-'));
  const path = join(directory, 'state.sqlite');
  let store = createStore(path, true);
  try {
    store.update(state => { state.stream.objective = 'Persist this objective'; });
    assert.equal(store.vote('refrigerator', 'fixed-voter').entry?.votes, 129);
    store.close();
    store = createStore(path, true);
    assert.equal(store.read().stream.objective, 'Persist this objective');
    assert.equal(store.vote('refrigerator', 'fixed-voter').status, 409);
    store.reset();
    assert.equal(store.vote('refrigerator', 'fixed-voter').entry?.votes, 129);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
