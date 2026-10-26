import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
// The packaging script is plain ESM so it also runs without a TypeScript toolchain.
// @ts-expect-error no separate declaration is needed for this build utility.
import { buildExtension, extensionFiles, validateApiOrigin } from '../scripts/build-extension.mjs';

test('Extension API origin validation rejects credentials and non-production destinations', () => {
  for (const value of [undefined, '', 'not-a-url', 'http://api.example.com', 'https://localhost', 'https://localhost.', 'https://[::ffff:127.0.0.1]', 'https://[fc00::1]', 'https://127.0.0.1', 'https://127.4.1.2', 'https://[::1]', 'https://10.0.0.2', 'https://192.168.1.1', 'https://172.31.0.1', 'https://demo.local', 'https://token:secret@api.example.com', 'https://api.example.com/api', 'https://api.example.com/?token=secret', 'https://api.example.com/#token']) assert.throws(() => validateApiOrigin(value), String(value));
  assert.equal(validateApiOrigin('https://streamlore-api.example.com/'), 'https://streamlore-api.example.com');
  assert.equal(validateApiOrigin('http://127.0.0.1:8787', true), 'http://127.0.0.1:8787');
  assert.equal(validateApiOrigin('http://localhost:8787', true), 'http://localhost:8787');
  assert.throws(() => validateApiOrigin('http://192.168.1.2', true));
  assert.throws(() => validateApiOrigin('http://api.example.com', true));
});

test('Extension ZIP includes only runtime assets, helper-first pages, and the compiled public origin', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'streamlore-extension-test-'));
  try {
    const outputDir = join(temporary, 'assets');
    const archivePath = join(temporary, 'upload.zip');
    const result = buildExtension({ apiUrl: 'https://api.example.com', outputDir, archivePath });
    const files: string[] = JSON.parse(execFileSync('python3', ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: print(json.dumps(z.namelist()))', archivePath], { encoding: 'utf8' }));
    assert.deepEqual(files.sort(), [...extensionFiles, 'config.js'].sort());
    assert.equal(result.apiOrigin, 'https://api.example.com');
    const config = readFileSync(join(outputDir, 'config.js'), 'utf8');
    assert.match(config, /"apiOrigin":"https:\/\/api\.example\.com"/);
    assert.match(config, /"localTest":false/);
    assert.doesNotMatch(config, /127\.0\.0\.1|localhost|secret|token/i, 'generated config contains public origin only');
    for (const file of ['panel.html', 'mobile.html', 'config.html', 'live.html']) {
      const html = readFileSync(join(outputDir, file), 'utf8');
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      assert.match(scripts[0][1], /https:\/\/extension-files\.twitch\.tv\/helper\/v1\/twitch-ext\.min\.js/);
      assert.equal(scripts.length, 2);
      assert.ok(scripts.every(match => match[2].trim() === '' && /\bsrc=/.test(match[1])));
      assert.doesNotMatch(html, /\son\w+\s*=|<iframe|<style\b/i);
    }
    const js = readFileSync(join(outputDir, 'assets/extension.js'), 'utf8');
    assert.match(js, /Authorization: `Bearer \$\{authorization\.token\}`/);
    assert.match(js, /credentials: 'omit'/);
    assert.match(js, /onAuthorized/);
    assert.doesNotMatch(js, /innerHTML|outerHTML|document\.write|\beval\s*\(|localStorage|sessionStorage|postMessage/);
    assert.ok(files.every(file => !file.startsWith('/') && !file.includes('..') && !file.includes('.env') && !file.endsWith('.ts')));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('local Extension package remains explicitly marked as a test build', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'streamlore-extension-local-'));
  try {
    buildExtension({ apiUrl: 'http://127.0.0.1:8787', localTest: true, outputDir: join(temporary, 'assets'), archivePath: join(temporary, 'local.zip') });
    assert.match(readFileSync(join(temporary, 'assets/config.js'), 'utf8'), /"localTest":true/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
