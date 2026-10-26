import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const extensionFiles = ['panel.html', 'mobile.html', 'config.html', 'live.html', 'assets/extension.js', 'assets/extension.css'];

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const mapped = host.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
  if (mapped) { const high = parseInt(mapped[1], 16); const low = parseInt(mapped[2], 16); return isPrivateHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`); }
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '::' || /^127\./.test(host) || /^0\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^(?:(?:fc|fd)[a-f0-9]{2}|fe[89ab][a-f0-9]):/i.test(host);
}
export function validateApiOrigin(value, localTest = false) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Provide --api-url https://your-api.example.com or STREAMLORE_EXTENSION_API_URL.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('The API URL must be a valid HTTPS origin.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use only the API origin, without credentials, path, query, or fragment.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(localTest && loopback && url.protocol === 'http:')) throw new Error('Production builds require HTTPS. HTTP is allowed only for loopback with --local-test.');
  if (!localTest && isPrivateHost(url.hostname)) throw new Error('Production builds cannot point at localhost or a private-network API. Use --local-test only for local testing.');
  return url.origin;
}
export function buildExtension({ apiUrl, localTest = false, outputDir = resolve(projectRoot, 'dist-extension'), archivePath = resolve(projectRoot, 'release/streamlore-twitch-extension.zip') } = {}) {
  const apiOrigin = validateApiOrigin(apiUrl, localTest);
  const staging = mkdtempSync(join(tmpdir(), 'streamlore-extension-'));
  try {
    for (const file of extensionFiles) {
      const source = join(projectRoot, 'extension', file);
      if (!existsSync(source)) throw new Error(`Missing Extension asset: ${file}`);
      mkdirSync(dirname(join(staging, file)), { recursive: true });
      cpSync(source, join(staging, file));
    }
    writeFileSync(join(staging, 'config.js'), `// Public API origin.\nexport const extensionConfig = Object.freeze(${JSON.stringify({ apiOrigin, localTest })});\n`);
    for (const file of extensionFiles.filter(file => file.endsWith('.html'))) {
      const html = readFileSync(join(staging, file), 'utf8');
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      if (!scripts.length || !scripts[0][1].includes('https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js')) throw new Error(`${file} must load the Twitch helper as its first script.`);
      if (scripts.some(match => match[2].trim() || !/\bsrc=/.test(match[1])) || /\son\w+\s*=/.test(html)) throw new Error(`${file} contains inline script or event handlers.`);
    }
    mkdirSync(dirname(archivePath), { recursive: true });
    const temporaryArchive = join(dirname(archivePath), `.${basename(archivePath)}.tmp`);
    execFileSync('python3', ['-c', 'import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED) as z:\n for p in sorted(root.rglob("*")):\n  if p.is_file(): z.write(p,p.relative_to(root).as_posix())', staging, temporaryArchive], { stdio: ['ignore', 'pipe', 'pipe'] });
    mkdirSync(outputDir, { recursive: true });
    for (const name of readdirSync(outputDir)) rmSync(join(outputDir, name), { recursive: true, force: true });
    cpSync(staging, outputDir, { recursive: true });
    cpSync(temporaryArchive, archivePath); rmSync(temporaryArchive, { force: true });
    return { apiOrigin, localTest, outputDir: resolve(outputDir), archivePath: resolve(archivePath), files: [...extensionFiles, 'config.js'] };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
function main() {
  const args = process.argv.slice(2);
  let apiUrl = process.env.STREAMLORE_EXTENSION_API_URL;
  let localTest = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--local-test') localTest = true;
    else if (args[i] === '--api-url' && args[i + 1]) apiUrl = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  const result = buildExtension({ apiUrl, localTest });
  process.stdout.write(`${localTest ? 'LOCAL TEST ONLY' : 'Production API'}: ${result.apiOrigin}\nAssets: ${result.outputDir}\nUpload archive: ${result.archivePath}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`Extension build failed: ${error.message}\n`); process.exitCode = 1; }
}
