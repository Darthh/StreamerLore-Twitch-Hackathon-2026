import { extensionConfig } from '../config.js';

const root = document.getElementById('app');
const mode = document.body.dataset.mode;
const creatorPage = mode === 'config' || mode === 'live';
const helper = window.Twitch?.ext;
const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const demo = isLoopback && new URLSearchParams(location.search).get('demo') === '1';
const categories = ['Inside joke', 'Tradition', 'Character', 'Moment'];
const kindLabels = { milestone: 'Milestone', setback: 'Plot twist', highlight: 'Highlight', context: 'Context' };
let authorization = null;
let generation = 0;
let state = null;
let status = null;
let moderator = null;
let tab = 'catchup';
let search = '';
let selectedId = null;
let creatorBuilt = false;
let refreshing = false;
let busy = false;
let visible = true;
let pendingOAuthUrl = '';
const requests = new Set();
const voted = new Set();

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function button(text, onClick, className = 'button secondary') {
  const element = node('button', className, text);
  element.type = 'button';
  if (onClick) element.addEventListener('click', onClick);
  return element;
}
function field(form, label, name, options = {}) {
  const wrapper = node('label', 'field');
  wrapper.append(node('span', 'field-label', label));
  const input = node(options.multiline ? 'textarea' : options.choices ? 'select' : 'input');
  input.name = name;
  input.id = `${form.id}-${name}`;
  if (options.multiline) input.rows = options.rows || 3;
  else if (!options.choices) input.type = options.type || 'text';
  if (options.choices) for (const choice of options.choices) { const option = node('option', '', typeof choice === 'string' ? choice : choice.label); option.value = typeof choice === 'string' ? choice : choice.value; input.append(option); }
  if (options.max) input.maxLength = options.max;
  if (options.placeholder) input.placeholder = options.placeholder;
  input.required = Boolean(options.required);
  wrapper.append(input);
  form.append(wrapper);
  return input;
}
function externalLink(text, value, onlyTwitch = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(isLoopback && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:')) return null;
    if (onlyTwitch && url.hostname !== 'clips.twitch.tv' && url.hostname !== 'www.twitch.tv' && url.hostname !== 'twitch.tv') return null;
    if (url.username || url.password) return null;
    const anchor = node('a', 'external-link', `${text} ↗`);
    anchor.href = url.href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.title = 'Opens in a new tab';
    return anchor;
  } catch { return null; }
}
function readableError(error) { return error instanceof Error ? error.message : 'StreamLore could not finish that request.'; }
function feedback(message, error = false) {
  const region = document.getElementById('feedback');
  if (!region) return;
  region.replaceChildren();
  if (!message) { region.hidden = true; return; }
  region.hidden = false;
  region.className = error ? 'feedback error' : 'feedback';
  region.setAttribute('role', error ? 'alert' : 'status');
  region.append(node('span', '', message), button('×', () => { region.hidden = true; }, 'dismiss'));
}
function textValue(form, name) { return String(new FormData(form).get(name) || '').trim(); }
function offset(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function canModerate() { return !demo && status?.canModerate === true; }
function shareIdentityButton() { return button('Share Twitch identity', () => { if (helper?.actions?.requestIdShare) helper.actions.requestIdShare(); else feedback('Identity sharing is unavailable. Reopen StreamLore inside Twitch.', true); }, 'button secondary'); }
function normalized(value) { return String(value || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(); }
function findLore(question) {
  const query = ` ${normalized(question)} `;
  return (state?.lore || []).filter(entry => entry.status === 'approved')
    .flatMap(entry => [entry.term, ...(entry.aliases || [])].map(alias => ({ entry, alias: normalized(alias) })))
    .filter(candidate => candidate.alias && query.includes(` ${candidate.alias} `))
    .sort((a, b) => b.alias.length - a.alias.length)[0]?.entry || null;
}
function validateState(value) {
  if (!value || typeof value !== 'object' || !value.channel || !value.stream || !Array.isArray(value.lore) || !Array.isArray(value.moments) || !Array.isArray(value.nominations)) throw new Error('The channel returned an incomplete update. Try refreshing.');
  return value;
}
async function request(path, body, method = 'POST') {
  if (!demo && !authorization?.token) throw new Error('Open StreamLore inside Twitch to authorize this channel.');
  if (demo && (body !== undefined || path !== '/state')) throw new Error('The standalone demo is read-only. Open the Extension inside Twitch for creator controls.');
  const origin = demo ? location.origin : extensionConfig.apiOrigin;
  if (!origin) throw new Error('StreamLore’s API is not configured. The developer must build the Extension with its public HTTPS API origin.');
  const current = generation;
  const controller = new AbortController();
  requests.add(controller);
  const timer = setTimeout(() => controller.abort(), ['/mod/draft', '/mod/recap'].includes(path) ? 55000 : 20000);
  try {
    const response = await fetch(`${origin}${demo ? '/api/state' : `/api/extension${path}`}`, {
      method: body === undefined ? 'GET' : method,
      headers: { ...(demo ? {} : { Authorization: `Bearer ${authorization.token}` }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit', cache: 'no-store', signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (current !== generation) throw new DOMException('Channel authorization changed.', 'AbortError');
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `StreamLore could not complete this request (${response.status}).`);
    return result;
  } catch (error) {
    if (current !== generation) throw new DOMException('Channel authorization changed.', 'AbortError');
    if (controller.signal.aborted) throw new Error('The connection timed out. Please try again.');
    if (error instanceof TypeError) throw new Error('Could not reach StreamLore’s API. Check the connection and allowed API domain.');
    throw error;
  } finally { clearTimeout(timer); requests.delete(controller); }
}
async function refresh() {
  if (refreshing || (!authorization && !demo)) return;
  const current = generation;
  refreshing = true;
  try {
    const [nextState, nextStatus] = await Promise.all([request('/state'), demo ? Promise.resolve({ role: 'viewer', configured: true, chat: { configured: false, connected: false, message: 'Read-only fictional demo' }, oauthConfigured: false }) : request('/status')]);
    if (current !== generation) return;
    state = validateState(nextState);
    status = nextStatus;
    if (canModerate() && creatorPage) moderator = await request('/mod/state');
    if (current !== generation) return;
    if (selectedId && ![...state.lore, ...state.nominations].some(entry => entry.id === selectedId)) { selectedId = null; document.getElementById('lore-detail')?.close(); }
    renderChannel();
    if (!document.getElementById('viewer-content').contains(document.activeElement)) renderViewer();
    if (creatorPage) renderCreator();
    document.getElementById('waiting').hidden = true;
    document.getElementById('connection-note').textContent = demo ? 'Read-only demo · fictional channel history' : 'Channel context · updates every 10 seconds';
  } catch (error) { if (current === generation && error?.name !== 'AbortError') feedback(readableError(error), true); }
  finally { if (current === generation) refreshing = false; }
}
async function run(work, success) {
  if (busy) return false;
  const current = generation;
  busy = true;
  document.querySelectorAll('[data-write]').forEach(element => { element.disabled = true; });
  feedback('');
  try {
    const result = await work();
    if (current !== generation) return false;
    if (success) feedback(typeof success === 'function' ? success(result) : success);
    await refresh();
    return true;
  } catch (error) { if (current === generation && error?.name !== 'AbortError') feedback(readableError(error), true); return false; }
  finally { if (current === generation) { busy = false; document.querySelectorAll('[data-write]').forEach(element => { element.disabled = false; }); } }
}
function writeButton(text, callback, className) { const element = button(text, callback, className); element.dataset.write = 'true'; element.disabled = busy; return element; }
function submit(form, text) { const element = writeButton(text, null, 'button primary'); element.type = 'submit'; const actions = node('div', 'actions'); actions.append(element); form.append(actions); return element; }
function section(title, description, className = 'section') { const element = node('section', className); element.append(node('h2', '', title)); if (description) element.append(node('p', 'muted section-description', description)); return element; }

function buildShell() {
  root.replaceChildren();
  const header = node('header', 'brand-bar');
  header.append(node('span', 'brand-mark', 'S'), node('strong', 'brand-name', 'StreamLore'), node('span', 'extension-label', creatorPage ? (mode === 'config' ? 'Setup' : 'Live controls') : 'Channel context'));
  const channel = node('div', 'channel'); channel.id = 'channel';
  const info = node('div', 'feedback'); info.id = 'feedback'; info.hidden = true;
  const waiting = section('Open inside Twitch', 'This panel uses Twitch’s secure authorization to show the right channel. Install or test it from the Twitch Extensions Manager.', 'waiting'); waiting.id = 'waiting';
  const retry = button('Refresh connection', () => refresh()); waiting.append(retry);
  if (isLoopback && !demo) { const preview = node('a', 'external-link', 'Open a read-only demo ↗'); preview.href = `${location.pathname}?demo=1`; preview.target = '_blank'; preview.rel = 'noopener noreferrer'; waiting.append(preview); }
  const viewer = node('section', 'viewer'); viewer.id = 'viewer'; viewer.hidden = creatorPage;
  const tabs = node('nav', 'tabs'); tabs.setAttribute('aria-label', 'StreamLore sections');
  for (const [value, label] of [['catchup', 'Catch up'], ['lore', 'Lore library']]) { const item = button(label, () => { tab = value; search = ''; renderViewer(); }, 'tab'); item.dataset.tab = value; tabs.append(item); }
  const viewerContent = node('div', 'viewer-content'); viewerContent.id = 'viewer-content'; viewer.append(tabs, viewerContent);
  const creator = node('section', 'creator'); creator.id = 'creator'; creator.hidden = !creatorPage;
  const footer = node('footer', 'footer'); const connection = node('span', '', 'Waiting for Twitch authorization…'); connection.id = 'connection-note'; footer.append(connection);
  root.append(header, channel, info, waiting, viewer, creator, footer);
  const dialog = node('dialog', 'lore-detail'); dialog.id = 'lore-detail'; dialog.setAttribute('aria-label', 'Channel lore backstory');
  dialog.addEventListener('click', event => { if (event.target === dialog) { selectedId = null; dialog.close(); } });
  dialog.addEventListener('close', () => { selectedId = null; });
  root.append(dialog);
}
function renderChannel() {
  const channel = document.getElementById('channel');
  channel.replaceChildren();
  if (!state) return;
  if (state.channel.profileImageUrl) {
    try { const url = new URL(state.channel.profileImageUrl, demo ? location.origin : undefined); if ((url.protocol === 'https:' && (url.hostname === 'static-cdn.jtvnw.net' || url.hostname.endsWith('.jtvnw.net'))) || (demo && url.origin === location.origin && url.pathname.startsWith('/assets/'))) { const image = node('img', 'avatar'); image.src = url.href; image.alt = ''; image.width = 38; image.height = 38; channel.append(image); } } catch { /* Missing profile media does not block the channel's text. */ }
  }
  if (!channel.firstChild) channel.append(node('span', 'avatar avatar-fallback', (state.channel.displayName || 'S').slice(0, 1).toUpperCase()));
  const content = node('div', 'channel-copy'); content.append(node('h1', '', state.channel.displayName || 'Your Twitch channel'), node('p', '', state.channel.title || 'Your stream. Your community’s backstory.'));
  const badge = node('span', state.mode === 'demo' ? 'badge' : state.channel.live ? 'badge live' : 'badge offline', state.mode === 'demo' ? 'DEMO' : state.channel.live ? 'LIVE' : 'OFFLINE');
  channel.append(content, badge);
}
function renderViewer() {
  if (!state || creatorPage) return;
  const content = document.getElementById('viewer-content');
  content.replaceChildren();
  document.querySelectorAll('[data-tab]').forEach(element => { element.classList.toggle('active', element.dataset.tab === tab); element.setAttribute('aria-pressed', String(element.dataset.tab === tab)); });
  if (tab === 'catchup') {
    const recap = section('What did I miss?', '', 'recap');
    const summary = node('ol', 'summary');
    for (const line of state.stream.summary || []) summary.append(node('li', '', line));
    if (!summary.childNodes.length) recap.append(node('p', 'muted', 'The streamer hasn’t recorded a recap yet. Check back for the next moment.'));
    recap.append(summary);
    if (state.mode === 'demo') recap.append(node('small', 'muted', 'Fictional demo history'));
    const objective = section('The mission right now', state.stream.objective || 'Waiting for the streamer’s next objective.', 'objective');
    const timeline = section('The story so far', '', 'timeline');
    for (const moment of state.moments.slice(0, 12)) {
      const item = node('article', 'moment'); const meta = node('div', 'moment-meta'); meta.append(node('span', 'tag', kindLabels[moment.kind] || 'Moment'), node('time', '', offset(moment.offsetSeconds)));
      item.append(meta, node('h3', '', moment.title), node('p', '', moment.body));
      if (moment.author?.login) item.append(node('small', 'attribution', `Added by ${moment.author.displayName || moment.author.login} (@${moment.author.login})`));
      const clip = externalLink('Watch moment on Twitch', moment.clipUrl, true); if (clip) item.append(clip);
      timeline.append(item);
    }
    if (!state.moments.length) timeline.append(node('p', 'muted', 'The next chapter will appear here.'));
    const quick = button('Get in on the channel lore →', () => { tab = 'lore'; renderViewer(); }, 'button secondary full-width');
    content.append(recap, objective, timeline, quick);
  } else {
    const question = node('form', 'ask-form'); question.id = 'ask-form';
    const input = field(question, 'What is chat talking about?', 'question', { placeholder: 'Why is chat saying refrigerator?', max: 300, required: true }); input.value = search;
    const ask = button('Get the backstory', null, 'button primary'); ask.type = 'submit'; question.append(ask);
    question.addEventListener('submit', event => { event.preventDefault(); search = input.value.trim(); const answer = findLore(search); if (answer) showLore(answer); else feedback('No approved backstory matches yet. Try a phrase from chat or browse below.'); });
    const library = section('Channel lore', 'Stories reviewed by this channel’s moderators.', 'library');
    const searchLabel = node('label', 'sr-only', 'Search approved lore'); searchLabel.htmlFor = 'library-search';
    const filter = node('input'); filter.id = 'library-search'; filter.placeholder = 'Search approved stories'; filter.type = 'search'; filter.value = search;
    const list = node('div', 'lore-list');
    const updateList = () => {
      list.replaceChildren(); const needle = normalized(filter.value);
      const entries = state.lore.filter(entry => normalized([entry.term, ...(entry.aliases || []), entry.explanation].join(' ')).includes(needle));
      for (const entry of entries) list.append(loreCard(entry, false));
      if (!entries.length) list.append(node('p', 'empty', 'No approved stories match. Try another phrase.'));
    };
    filter.addEventListener('input', () => { search = filter.value; updateList(); }); updateList(); library.append(searchLabel, filter, list);
    content.append(question);
    if (state.nominations.length) { const ballot = section('Vote a story into the lore', 'These drafts have already been reviewed by moderators.', 'ballot'); for (const entry of state.nominations) ballot.append(loreCard(entry, true)); content.append(ballot); }
    content.append(library);
  }
  if (selectedId) { const selected = [...state.lore, ...state.nominations].find(entry => entry.id === selectedId); if (selected) renderDetail(selected); }
}
function loreCard(entry, nominated) {
  const item = node('article', 'lore-card');
  const title = button(entry.term, () => showLore(entry), 'lore-title');
  item.append(node('span', 'category', entry.category), title, node('p', '', entry.explanation));
  const attribution = entry.reviewedBy || entry.author; if (attribution?.login) item.append(node('small', 'attribution', `${entry.reviewedBy ? 'Reviewed' : 'Added'} by ${attribution.displayName || attribution.login} (@${attribution.login})`));
  const bottom = node('div', 'lore-bottom'); bottom.append(button('The backstory →', () => showLore(entry), 'text-button'));
  if (nominated) bottom.append(node('span', 'vote-count', `${entry.votes}/5 votes`));
  if (!demo && status?.canVote) bottom.append(writeButton(voted.has(entry.id) ? 'Voted ✓' : nominated ? 'Vote it in' : `↑ ${entry.votes}`, () => vote(entry), 'button secondary vote-button'));
  const voteButton = bottom.lastChild; if (voted.has(entry.id) && voteButton?.tagName === 'BUTTON') voteButton.disabled = true;
  item.append(bottom); if (!demo && !status?.canVote && nominated) { item.append(node('small', 'muted', 'Sign in to Twitch and share your identity to vote.'), shareIdentityButton()); } return item;
}
async function vote(entry) {
  if (await run(() => request(`/lore/${encodeURIComponent(entry.id)}/vote`, {}), 'Your vote is in.')) { voted.add(entry.id); renderViewer(); }
}
function showLore(entry) {
  selectedId = entry.id;
  const dialog = document.getElementById('lore-detail'); renderDetail(entry);
  if (!dialog.open) dialog.showModal();
}
function renderDetail(entry) {
  const dialog = document.getElementById('lore-detail'); dialog.replaceChildren();
  const heading = node('header', 'dialog-heading'); const close = button('×', () => { selectedId = null; dialog.close(); }, 'close-button'); close.setAttribute('aria-label', 'Close backstory'); heading.append(node('span', 'category', entry.category), close);
  dialog.append(heading, node('h2', '', entry.term), node('p', 'detail-explanation', entry.explanation), node('h3', 'origin-heading', 'Where it started'), node('p', 'origin', entry.origin));
  const clip = externalLink('Watch the origin clip on Twitch', entry.clipUrl, true);
  const author = entry.reviewedBy || entry.author; if (author?.login) dialog.append(node('small', 'attribution', `${entry.reviewedBy ? 'Reviewed' : 'Added'} by ${author.displayName || author.login} (@${author.login})`));
  dialog.append(clip || node('small', 'muted', entry.source === 'demo' ? 'Demo origin · no clip attached' : 'No origin clip attached yet'), node('p', 'reviewed', entry.status === 'nominated' ? `Mod reviewed · community vote ${entry.votes}/5` : 'Moderator approved'));
}
function creatorForm(id, title, description) { const form = node('form', 'creator-form'); form.id = id; form.append(node('h3', '', title)); if (description) form.append(node('p', 'muted', description)); return form; }
function renderCreator() {
  const parent = document.getElementById('creator');
  if (!canModerate()) { parent.replaceChildren(); creatorBuilt = false; const creatorRole = !demo && ['broadcaster', 'moderator'].includes(status?.role); if (!creatorRole) { parent.append(node('p', 'empty', demo ? 'The standalone demo is read-only. Open this view inside Twitch for channel controls.' : 'Only this channel’s broadcaster and moderators can use creator controls.')); if (!demo && !status?.identityLinked) parent.append(node('p', 'muted', 'If you moderate this channel, share your identity so Twitch can verify your role.'), shareIdentityButton()); return; } const connection = section('1. Connect your channel', 'Connect the broadcaster’s Twitch account and share your Twitch identity to publish channel context with verified creator attribution.', 'setup-step'); connection.id = 'connection-step'; parent.append(connection); if (!status.identityLinked) parent.append(shareIdentityButton()); parent.append(node('p', 'muted', status.identityLinked ? 'The broadcaster must connect the channel account before stories can be published. Viewers can keep reading existing approved context.' : 'Twitch identity sharing is required to verify creator permissions. Reading approved lore does not require sharing.')); renderConnection(); return; }
  if (!creatorBuilt) {
    parent.replaceChildren();
    const connection = section('1. Connect your channel', 'The broadcaster account verifies creator attribution. Chat replies are sent as this connected account. The connection enables !catchup, !lore, and phrase detection.', 'setup-step'); connection.id = 'connection-step';
    const objective = creatorForm('objective-form', '2. Set the current objective', 'Give new viewers a clear answer to “what are we trying to do?”');
    const objectiveInput = field(objective, 'Stream objective', 'objective', { multiline: true, required: true, max: 300 }); objectiveInput.value = state.stream.objective || '';
    submit(objective, 'Save objective');
    objective.addEventListener('submit', event => { event.preventDefault(); run(() => request('/mod/objective', { objective: textValue(objective, 'objective') }), 'Objective updated.'); });
    const moment = creatorForm('moment-form', '3. Mark a moment', 'Record a victory, a setback, or the context newcomers need.');
    field(moment, 'Title', 'title', { required: true, max: 120 }); field(moment, 'What happened?', 'body', { multiline: true, required: true, max: 1400 }); field(moment, 'Kind of moment', 'kind', { choices: Object.entries(kindLabels).map(([value, label]) => ({ value, label })) }); field(moment, 'Twitch clip URL (optional)', 'clipUrl', { type: 'url' }); submit(moment, 'Add to timeline');
    moment.addEventListener('submit', async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(moment)); if (await run(() => request('/mod/moments', values), 'Moment added.')) moment.reset(); });
    const lore = creatorForm('lore-form', 'Add channel lore', 'New stories stay private in the review queue until approved.');
    field(lore, 'Joke or phrase', 'term', { required: true, max: 80 }); field(lore, 'Explain it to someone new', 'explanation', { multiline: true, required: true, max: 1400 }); field(lore, 'Where did it start?', 'origin', { multiline: true, required: true, max: 2000 }); field(lore, 'Other names (comma separated)', 'aliases', { max: 500 }); field(lore, 'Category', 'category', { choices: categories }); field(lore, 'Twitch origin clip URL (optional)', 'clipUrl', { type: 'url' }); submit(lore, 'Save draft for review');
    lore.addEventListener('submit', async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(lore)); values.aliases = textValue(lore, 'aliases').split(',').map(value => value.trim()).filter(Boolean); if (await run(() => request('/mod/lore', values), 'Draft added to the review queue.')) lore.reset(); });
    const drafts = section('4. Review the backstory', 'Verify the joke, its origin, and clip before sharing. Send reviewed stories to a community vote or approve them directly.', 'setup-step'); drafts.id = 'review-step';
    const ai = creatorForm('ai-form', 'Draft from captions and clip evidence', 'AI suggestions require moderator review. A clip URL alone does not let AI watch its video.');
    field(ai, 'Streamer-provided captions or approved notes', 'captions', { multiline: true, rows: 5, max: 30000 }); field(ai, 'Twitch origin clip URL (optional)', 'clipUrl', { type: 'url' }); field(ai, 'Clip title (optional)', 'clipTitle', { max: 160 }); field(ai, 'Clip transcript (optional)', 'clipTranscript', { multiline: true, rows: 3, max: 15000 });
    const aiButtons = node('div', 'actions'); aiButtons.append(writeButton('Update recap', () => { const captions = textValue(ai, 'captions'); if (!captions) return feedback('Add captions or approved notes first.', true); run(() => request('/mod/recap', { captions }), 'Catch-up recap updated.'); }), writeButton('Draft lore', () => { const values = Object.fromEntries(new FormData(ai)); if (!String(values.captions).trim() && !String(values.clipTranscript).trim()) return feedback('Add captions or a clip transcript first.', true); run(() => request('/mod/draft', values), result => result.message || 'Drafts are ready for moderator review.'); }, 'button primary')); ai.append(aiButtons);
    const drops = section('Published context & overlay', 'Edit or remove published content, and drop an approved classic onto your stream overlay.', 'setup-step'); drops.id = 'drop-step';
    const finish = section('Ready for your channel', 'Save setup after adding a stream objective. Then activate StreamLore in your Twitch Extensions Manager.', 'setup-step'); finish.id = 'finish-step';
    parent.append(connection, objective, moment, lore, drafts, ai, drops, finish);
    creatorBuilt = true;
  }
  renderConnection(); renderReviews(); renderDrops(); renderFinish();
  const aiMessage = document.getElementById('ai-availability') || node('p', 'muted'); aiMessage.id = 'ai-availability'; aiMessage.textContent = state.connection?.ai?.message || 'AI availability is checked by the backend.'; document.getElementById('ai-form').append(aiMessage);
}
function renderConnection() {
  const section = document.getElementById('connection-step');
  section.querySelectorAll('.connection-details').forEach(element => element.remove());
  const details = node('div', 'connection-details');
  details.append(node('p', status.chat?.connected ? 'connection good' : 'connection', status.chat?.message || 'Chat is not connected.'));
  if (status.connectedAccount) details.append(node('p', 'muted', `Connected account: ${status.connectedAccount.displayName || status.connectedAccount.login}`));
  if (status.role !== 'broadcaster') details.append(node('p', 'muted', 'Only the broadcaster can connect or disconnect their Twitch account.'));
  else if (status.connectedAccount || status.chat?.configured) details.append(writeButton('Disconnect channel account', async () => { pendingOAuthUrl = ''; await run(() => request('/connection', {}, 'DELETE'), 'Channel account disconnected. Existing approved context remains readable; reconnect before publishing.'); }));
  else if (status.oauthConfigured) details.append(writeButton('Connect channel account', async () => { await run(async () => { const result = await request('/connect', {}); const url = new URL(result.url); if (url.protocol !== 'https:' || url.hostname !== 'id.twitch.tv' || url.pathname !== '/oauth2/authorize') throw new Error('The server returned an invalid Twitch authorization link.'); pendingOAuthUrl = url.href; renderConnection(); }, 'Continue on Twitch in the link below, then return here.'); }));
  else details.append(node('p', 'muted', 'Account authorization is not configured on this server. Ask the developer to configure Twitch OAuth before publishing channel context.'));
  if (pendingOAuthUrl) { const link = externalLink('Continue to Twitch authorization', pendingOAuthUrl); if (link) details.append(link); }
  details.append(button('Refresh connection status', () => refresh(), 'text-button'));
  section.append(details);
}
function renderReviews() {
  const section = document.getElementById('review-step'); section.querySelectorAll('.review-list').forEach(element => element.remove());
  const list = node('div', 'review-list');
  for (const entry of moderator?.pending || []) {
    const item = node('article', 'review-card'); item.append(node('span', 'category', entry.source === 'ai' ? 'AI draft · needs review' : 'Draft · needs review'), node('h3', '', entry.term), node('p', '', entry.explanation), node('p', 'origin', entry.origin));
    const clip = externalLink('Check origin clip on Twitch', entry.clipUrl, true); if (clip) item.append(clip);
    const actions = node('div', 'actions'); actions.append(writeButton('Reject', () => run(() => request(`/mod/lore/${encodeURIComponent(entry.id)}`, { status: 'rejected' }, 'PATCH'), 'Draft rejected.')), writeButton('Edit', () => editLore(entry)), writeButton('Send to vote', () => run(() => request(`/mod/lore/${encodeURIComponent(entry.id)}`, { status: 'nominated' }, 'PATCH'), 'Reviewed story sent to community vote.')), writeButton('Approve', () => run(() => request(`/mod/lore/${encodeURIComponent(entry.id)}`, { status: 'approved' }, 'PATCH'), 'Story approved and added to the library.'), 'button primary')); item.append(actions); list.append(item);
  }
  if (!moderator?.pending?.length) list.append(node('p', 'empty', 'No drafts waiting for review.'));
  section.append(list);
}
function editLore(entry) {
  const dialog = document.getElementById('lore-detail'); dialog.replaceChildren();
  const heading = node('header', 'dialog-heading'); heading.append(node('h2', '', 'Edit the story'), button('×', () => dialog.close(), 'close-button')); heading.lastChild.setAttribute('aria-label', 'Close editor');
  const form = creatorForm('edit-lore-form', entry.term, 'Check the origin before approving this draft.');
  for (const [label, name, options] of [['Joke or phrase', 'term', { required: true, max: 80 }], ['Explanation', 'explanation', { multiline: true, required: true, max: 1400 }], ['Origin', 'origin', { multiline: true, required: true, max: 2000 }], ['Category', 'category', { choices: categories }], ['Twitch clip URL (optional)', 'clipUrl', { type: 'url' }]]) { const input = field(form, label, name, options); input.value = entry[name] || ''; }
  const localError = node('p', 'inline-error'); localError.setAttribute('role', 'alert'); form.append(localError); submit(form, 'Save changes');
  form.addEventListener('submit', async event => { event.preventDefault(); localError.textContent = ''; const values = Object.fromEntries(new FormData(form)); const result = await run(() => request(`/mod/lore/${encodeURIComponent(entry.id)}`, values, 'PATCH'), 'Story updated.'); if (result) dialog.close(); else localError.textContent = 'Could not save. Your edits are still here; check the connection or field values and try again.'; });
  dialog.append(heading, form); if (!dialog.open) dialog.showModal();
}
function renderDrops() {
  const section = document.getElementById('drop-step'); section.querySelectorAll('.drop-list').forEach(element => element.remove());
  const list = node('div', 'drop-list');
  if (status.overlayUrl) { const link = externalLink('Open browser-source overlay', status.overlayUrl); if (link) list.append(link); }
  for (const entry of [...state.lore, ...state.nominations]) { const row = node('div', 'drop-row'); row.append(node('strong', '', entry.term), writeButton('Edit', () => editLore(entry)), writeButton('Remove story', () => run(() => request(`/mod/lore/${encodeURIComponent(entry.id)}`, { status: 'rejected' }, 'PATCH'), 'Story removed from public view.'))); if (entry.status === 'approved') row.append(writeButton('Drop on stream', () => run(() => request(`/mod/lore/${encodeURIComponent(entry.id)}/drop`, {}), 'Lore dropped on the overlay.'))); list.append(row); }
  for (const moment of state.moments) { const row = node('div', 'drop-row'); row.append(node('strong', '', moment.title), writeButton('Remove moment', () => run(() => request(`/mod/moments/${encodeURIComponent(moment.id)}`, {}, 'DELETE'), 'Moment removed from the timeline and recap.'))); list.append(row); }
  if (state.loreDrop) list.append(writeButton('Clear overlay card', () => run(() => request('/mod/drop', {}, 'DELETE'), 'Overlay cleared.')));
  if (!state.lore.length) list.append(node('p', 'muted', 'Approve a story to enable lore drops.'));
  section.append(list);
}
function renderFinish() {
  const section = document.getElementById('finish-step'); section.querySelectorAll('.finish-controls').forEach(element => element.remove());
  const controls = node('div', 'finish-controls');
  controls.append(node('p', status.configured ? 'connection good' : 'muted', status.configured ? 'Setup saved for this channel.' : 'Setup has not been marked complete.'));
  if (status.role === 'broadcaster') controls.append(writeButton('Save channel setup', async () => {
    if (!state.stream.objective?.trim()) return feedback('Set a stream objective before completing setup.', true);
    await run(async () => { await request('/configure', {}); if (!helper?.configuration?.set) throw new Error('Setup reached the server, but the Twitch helper is unavailable. Reopen configuration inside Twitch.'); helper.configuration.set('broadcaster', '1', JSON.stringify({ configured: true })); }, 'Channel setup saved. You can now activate StreamLore in Twitch.');
  }, 'button primary'));
  else controls.append(node('p', 'muted', 'The broadcaster completes installation. Moderators can manage the channel’s context above.'));
  section.append(controls);
}

buildShell();
if (demo) {
  refresh();
} else if (helper?.onAuthorized) {
  helper.onAuthorized(auth => {
    const changedChannel = authorization?.channelId !== auth.channelId;
    generation += 1;
    for (const request of requests) request.abort();
    requests.clear(); refreshing = false; busy = false;
    authorization = { token: auth.token, channelId: auth.channelId };
    if (changedChannel) { state = null; status = null; moderator = null; creatorBuilt = false; selectedId = null; pendingOAuthUrl = ''; voted.clear(); document.getElementById('lore-detail').close(); document.getElementById('viewer-content').replaceChildren(); document.getElementById('creator').replaceChildren(); }
    refresh();
  });
  helper.onContext?.(context => { if (context.theme === 'light' || context.theme === 'dark') document.documentElement.dataset.theme = context.theme; });
  helper.onError?.(() => feedback('Twitch could not authorize this panel. Refresh the channel page and try again.', true));
  helper.onVisibilityChanged?.(isVisible => { visible = isVisible; if (visible) refresh(); });
}
const poll = setInterval(() => { if (visible && !document.hidden && !busy) refresh(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('pagehide', () => { clearInterval(poll); for (const request of requests) request.abort(); });
