import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { aiConfigured, draftLore, summarizeStream } from '../server/ai.ts';
import { chatReply, parseCommand, startTwitch } from '../server/twitch.ts';
import type { Connection } from '../shared/types.ts';

const aiEnvironment = (t: TestContext) => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-not-real';
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
};
const responseWith = (data: unknown) => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data) }] }] }), { status: 200 });
const draft = { term: 'Refrigerator', aliases: ['fridge'], explanation: 'The chat calls the failed shelter a refrigerator.', origin: 'The supplied captions explain the nickname; historical origin is unknown.', clipUrl: '', category: 'Inside joke' };
const input = { captions: 'The chat calls my failed shelter a refrigerator.', chat: [], existingTerms: [] };

test('commands accept exact names and cap untrusted queries', () => {
  assert.deepEqual(parseCommand('  !LORE refrigerator  '), { name: 'lore', query: 'refrigerator' });
  assert.deepEqual(parseCommand('!catchup'), { name: 'catchup', query: '' });
  assert.deepEqual(parseCommand('!lorevote fridge'), { name: 'lorevote', query: 'fridge' });
  assert.equal(parseCommand('!lorekeeper'), null);
  assert.equal(parseCommand('hello !lore'), null);
  assert.equal(parseCommand(`!lore ${'x'.repeat(201)}`), null);
});

test('chat replies are single-line, bounded, and preserve companion URL', () => {
  const options = { getCatchup: () => 'x'.repeat(700), getLore: (query: string) => `Approved ${query}\nOrigin` };
  const reply = chatReply({ name: 'catchup', query: '' }, options, 'https://example.com/');
  assert.ok(reply.length <= 500);
  assert.ok(reply.endsWith('https://example.com'));
  assert.equal(chatReply({ name: 'lore', query: 'fridge' }, options, ''), 'Approved fridge Origin');
  assert.ok(!chatReply({ name: 'catchup', query: '' }, options, 'javascript:alert(1)').includes('javascript:'));
  const clip = 'https://clips.twitch.tv/VerifiedOriginClip';
  const longLore = chatReply({ name: 'lore', query: 'fridge' }, { ...options, getLore: () => `${'Backstory '.repeat(150)}${clip}` }, 'https://example.com');
  assert.ok(longLore.length <= 500);
  assert.ok(longLore.endsWith(clip));
});

test('Twitch without credentials makes no requests and reports disconnected', t => {
  const names = ['TWITCH_CLIENT_ID', 'TWITCH_ACCESS_TOKEN', 'TWITCH_CHANNEL'];
  const previous = names.map(name => process.env[name]);
  names.forEach(name => delete process.env[name]);
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No network request expected'); });
  const connections: Connection[] = [];
  const client = startTwitch({ onChat() {}, onStatus(status) { connections.push(status); }, getCatchup: () => '', getLore: () => '' });
  assert.equal(connections[0]?.configured, false);
  assert.equal(connections[0]?.connected, false);
  client.close();
});

test('Twitch rejects expired credentials without opening a socket or exposing the token', async t => {
  const values = { TWITCH_CLIENT_ID: 'test-client', TWITCH_ACCESS_TOKEN: 'private-test-token', TWITCH_CHANNEL: 'testchannel' };
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => Object.entries(previous).forEach(([name, value]) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; }));
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
  const statuses: Connection[] = [];
  const client = startTwitch({ onChat() {}, onStatus(status) { statuses.push(status); }, getCatchup: () => '', getLore: () => '' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(statuses.some(status => status.message.includes('expired or was revoked')));
  assert.ok(statuses.every(status => !status.connected && !status.message.includes('private-test-token')));
  client.close();
});

test('account-backed Twitch requests fetch current credentials and retry a 401 with one refresh', async t => {
  const requests: string[] = [], refreshes: boolean[] = [], statuses: Connection[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests.push(new Headers(init.headers).get('Authorization') || '');
    if (requests.length === 1) return new Response('{}', { status: 401 });
    // Deliberately omit a required scope to stop before opening any real socket.
    return new Response(JSON.stringify({ user_id: '12345', client_id: 'oauth-client', scopes: ['user:read:chat'] }));
  });
  const client = startTwitch({
    config: { clientId: 'oauth-client', channelLogin: 'testchannel', async getAccessToken(force) { refreshes.push(Boolean(force)); return force ? 'rotated-token' : 'old-token'; } },
    onChat() {}, onStatus(status) { statuses.push(status); }, getCatchup: () => '', getLore: () => '',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(requests, ['OAuth old-token', 'OAuth rotated-token']);
  assert.ok(statuses.some(status => status.message.includes('needs user:read:chat and user:write:chat')));
  assert.ok(statuses.every(status => !status.connected)); client.close();
});

test('missing API key is an explicit unavailable state', async t => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (previous !== undefined) process.env.OPENAI_API_KEY = previous; });
  assert.equal(aiConfigured(), false);
  await assert.rejects(draftLore(input), /AI is not connected/);
});

test('lore drafting uses strict structured output and does not expose the key in input', async t => {
  aiEnvironment(t);
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body as string);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.type, 'json_schema');
    assert.ok(body.instructions.includes('untrusted source material'));
    assert.ok(!body.input.includes('test-key-not-real'));
    return responseWith({ entries: [draft] });
  });
  assert.deepEqual(await draftLore(input), [draft]);
});

test('lore drafting omits duplicate terms and rejects fabricated clip URLs', async t => {
  aiEnvironment(t);
  t.mock.method(globalThis, 'fetch', async () => responseWith({ entries: [draft] }));
  assert.deepEqual(await draftLore({ ...input, existingTerms: ['REFRIGERATOR'] }), []);
  t.mock.method(globalThis, 'fetch', async () => responseWith({ entries: [{ ...draft, clipUrl: 'https://clips.twitch.tv/Fictional' }] }));
  await assert.rejects(draftLore(input), /unverified clip/);
});

test('a known clip URL is accepted only when a transcript was supplied', async t => {
  aiEnvironment(t);
  const url = 'https://clips.twitch.tv/VerifiedSource';
  t.mock.method(globalThis, 'fetch', async () => responseWith({ entries: [{ ...draft, clipUrl: url }] }));
  const clips = [{ url, title: 'A shelter', transcript: 'I am calling this shelter a refrigerator.' }];
  assert.equal((await draftLore({ ...input, clips }))[0].clipUrl, url);
  await assert.rejects(draftLore({ ...input, clips: [{ ...clips[0], transcript: '' }] }), /unverified clip/);
});

test('recap validates output length and handles refusals', async t => {
  aiEnvironment(t);
  const recapInput = { objective: 'Finish the shelter', moments: [], captions: 'We finished the roof.' };
  t.mock.method(globalThis, 'fetch', async () => responseWith({ bullets: ['The roof is complete.'] }));
  assert.deepEqual(await summarizeStream(recapInput), ['The roof is complete.']);
  t.mock.method(globalThis, 'fetch', async () => responseWith({ bullets: ['x'.repeat(351)] }));
  await assert.rejects(summarizeStream(recapInput), /oversized text/);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'refusal' }] }] })));
  await assert.rejects(summarizeStream(recapInput), /could not draft/);
});

test('API failures and incomplete responses never become generated content', async t => {
  aiEnvironment(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('secret provider message', { status: 429 }));
  await assert.rejects(draftLore(input), /AI request failed \(429\)/);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: 'incomplete', output: [] })));
  await assert.rejects(draftLore(input), /did not complete/);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('test-key-not-real'); });
  await assert.rejects(draftLore(input), error => error instanceof Error && !error.message.includes('test-key-not-real') && error.message.includes('timed out'));
});
