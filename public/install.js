const byId = id => document.getElementById(id);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

function safeTwitchInstall(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.hostname !== 'dashboard.twitch.tv' && url.hostname !== 'www.twitch.tv') return null;
    if (url.hostname === 'www.twitch.tv' && !/^\/ext\//.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
function safePreview(value) {
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || !/^\/extension\/(?:panel|mobile)\.html$/.test(url.pathname)) return null;
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) return null;
    if (url.searchParams.get('demo') === '1' && !loopback) return null;
    return url.href;
  } catch { return null; }
}
function check(label, passed, detail) {
  const item = document.createElement('li');
  const icon = document.createElement('span'); icon.className = passed ? 'check-icon ready' : 'check-icon'; icon.textContent = passed ? '✓' : '—'; icon.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('span');
  const title = document.createElement('strong'); title.textContent = label;
  const description = document.createElement('span'); description.textContent = detail;
  copy.append(title, description); item.append(icon, copy); return item;
}
function resetInstallButton() {
  const button = byId('install-button'); button.removeAttribute('href'); button.removeAttribute('target'); button.classList.add('disabled'); button.setAttribute('aria-disabled', 'true'); button.tabIndex = -1;
}
async function loadStatus() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  byId('error').hidden = true;
  byId('retry').disabled = true;
  resetInstallButton();
  byId('release-badge').classList.remove('ready');
  byId('availability').classList.remove('ready');
  byId('readiness-dot').classList.remove('ready');
  byId('preview-row').hidden = true;
  byId('package-link').hidden = true;
  byId('package-note').hidden = true;
  try {
    const response = await fetch('/api/install/status', { cache: 'no-store', credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error('Installation status is unavailable right now. Please try again.');
    const status = await response.json();
    if (!status || !status.extension || !status.backend || !status.oauth || !status.package || !Array.isArray(status.missing)) throw new Error('The installation service returned an incomplete status. Please try again.');
    const installUrl = status.extension.released === true ? safeTwitchInstall(status.extension.installUrl) : null;
    const ready = Boolean(installUrl);
    byId('release-badge').textContent = ready ? 'Available on Twitch' : 'Prerelease';
    byId('release-badge').classList.toggle('ready', ready);
    byId('availability').classList.toggle('ready', ready);
    byId('availability-title').textContent = ready ? 'Ready for your channel' : 'Twitch review required';
    byId('availability-description').textContent = ready ? 'Add StreamLore through Twitch, configure your channel’s context, then activate your panel.' : 'The native panel is built. Public installation will be available after Twitch approves and releases the Extension.';
    byId('install-note').textContent = ready ? 'Installs through Twitch. Viewers don’t need a download or a separate account.' : 'You can try the demo now. Developers and allowlisted accounts can use Twitch’s Local Test and Hosted Test.';
    if (ready) {
      const button = byId('install-button'); button.href = installUrl; button.target = '_blank'; button.rel = 'noopener noreferrer'; button.classList.remove('disabled'); button.setAttribute('aria-disabled', 'false'); button.tabIndex = 0;
    }
    const preview = safePreview(status.previewUrl);
    document.querySelectorAll('[data-demo-link]').forEach(link => { link.hidden = !preview; });
    byId('preview-row').hidden = !preview;
    if (preview) byId('preview-link').href = preview;
    const checks = byId('readiness-list'); checks.replaceChildren(
      check('Twitch Extension registered', status.extension.registered === true, status.extension.registered ? 'An Extension client ID is configured.' : 'Register StreamLore in the Twitch developer console.'),
      check('Public backend configured', status.backend.configured === true, status.backend.configured ? 'The channel API has a public service configuration.' : 'Configure the hosted HTTPS backend and its server-side secrets.'),
      check('Twitch account authorization', status.oauth.configured === true, status.oauth.configured ? 'Broadcaster authorization is configured.' : 'Register the OAuth application and callback URL.'),
      check('Native asset package', status.package.available === true, status.package.available ? status.package.localTest ? 'Local test package only. Rebuild with the public API before Hosted Test.' : 'A package is available for Twitch asset upload.' : 'Build the native Extension package.'),
      check('Twitch review and release', ready, ready ? 'Streamers can add the released Extension.' : 'Complete Hosted Test, submit for review, and release the approved version.')
    );
    const infrastructureReady = status.extension.registered === true && status.backend.configured === true && status.oauth.configured === true && status.package.available === true && !status.package.localTest;
    byId('readiness-label').textContent = ready ? 'Ready to install' : infrastructureReady ? 'Ready for Twitch testing' : 'Setup in progress';
    byId('readiness-dot').classList.toggle('ready', ready || infrastructureReady);
    const missing = status.missing.filter(item => typeof item === 'string' && item.trim());
    byId('missing-section').hidden = missing.length === 0;
    byId('missing-list').replaceChildren(...missing.map(value => { const item = document.createElement('li'); item.textContent = value; return item; }));
    const packageLink = byId('package-link'); packageLink.hidden = true; packageLink.removeAttribute('href');
    byId('package-note').hidden = true;
    if (status.package.available === true && status.package.url === '/downloads/streamlore-twitch-extension.zip') {
      packageLink.href = status.package.url;
      packageLink.download = 'streamlore-twitch-extension.zip';
      packageLink.textContent = status.package.localTest ? 'Download local test package ↓' : 'Download Extension upload package ↓';
      packageLink.hidden = false;
      byId('package-note').hidden = false;
      byId('package-note').textContent = status.package.localTest ? 'Local test package: points to a loopback API. This developer asset is not a streamer install and is not ready for public upload.' : 'Developer upload package for the Twitch Extensions Manager. Streamers install the released version through Twitch.';
    }
  } catch (error) {
    byId('release-badge').textContent = 'Status unavailable';
    byId('availability-title').textContent = 'We couldn’t check Twitch availability';
    byId('availability-description').textContent = 'Try again in a moment. The StreamLore demo is still available.';
    byId('error-message').textContent = controller.signal.aborted ? 'The status request timed out. Please check your connection and retry.' : error instanceof Error ? error.message : 'Could not load installation status.';
    byId('error').hidden = false;
    byId('readiness-label').textContent = 'Status unavailable';
  } finally { clearTimeout(timeout); byId('retry').disabled = false; }
}
byId('install-button').addEventListener('click', event => { if (byId('install-button').getAttribute('aria-disabled') === 'true') event.preventDefault(); });
byId('retry').addEventListener('click', loadStatus);
loadStatus();
