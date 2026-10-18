import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildRelease, browserManifest } from '../scripts/build-release.mjs';
import { unzipSync } from '../extension/vendor/fflate/fflate.js';

const root = new URL('..', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('extension/manifest.json', root)));

test('reviewed runtime libraries retain their exact upstream release bytes', () => {
  for (const [file, expected] of [
    ['pdfjs/pdf.min.mjs', '343b4166b06716a55a8f87175b83223cb1a9ab701eb8a96b2577509d47fbaf4a'],
    ['pdfjs/pdf.worker.min.mjs', 'dbcae78a691b3c501508f74b774c6066a57a14a76cefdc9e25ad86b651bb75d5'],
    ['pdfjs/wasm/openjpeg.wasm', '67b8e2b162da472e98cb48d3d32e3e38fff481b9b32ff4818e78bb248af88ab2'],
    ['pdfjs/wasm/openjpeg_nowasm_fallback.js', '07c3c3361827308741bc31c561b59e705ebb4d1e8efb84e4d24884e230dbb894'],
    ['pdfjs/wasm/qcms_bg.wasm', '6017eca5939cde1836e88e6d8cd27ae039246f206515ea4487bdfd0e3fb16e26'],
    ['fflate/fflate.js', '8cc1f687e0159e977addb6b85e274dbd11e622cf151f4fcb7b85d49622ea43e7'],
    ['tokenizers/tokenizers.mjs', '1c4a848f86156201c033d6cd08c4cf81ae1088552acec3367f31ef086edf5af0'],
    ['linkedom/worker.js', 'ea9f1de69b009d210968dd8f4d3f4ecf1095bedf80d389ec83244c1713578288'],
  ]) assert.equal(createHash('sha256').update(readFileSync(new URL(`extension/vendor/${file}`, root))).digest('hex'), expected, file);
});

test('release manifests select the correct background and native panel APIs', () => {
  const firefox = browserManifest(manifest, 'firefox');
  assert.deepEqual(firefox.background, { scripts: ['background-firefox.js'], type: 'module' });
  assert.equal(firefox.side_panel, undefined);
  assert.equal(firefox.minimum_chrome_version, undefined);
  assert.ok(!firefox.permissions.includes('sidePanel'));
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '140.0');
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.required, ['authenticationInfo', 'personalCommunications', 'websiteContent']);
  assert.equal(firefox.incognito, 'not_allowed');
  const chrome = browserManifest(manifest, 'chrome');
  assert.deepEqual(chrome.background, { service_worker: 'background.js', type: 'module' });
  assert.equal(chrome.sidebar_action, undefined);
  assert.equal(chrome.browser_specific_settings, undefined);
  assert.equal(chrome.minimum_chrome_version, '124');
  assert.throws(() => browserManifest(manifest, 'edge'), /Unknown release browser/);
});

test('release archives contain the runtime, exclude private data, and rebuild without Git', { timeout: 90_000 }, () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'boilerspace-release-'));
  try {
    const outDir = path.join(temporary, 'first');
    const built = buildRelease({ outDir });
    for (const item of built) {
      const files = unzipSync(readFileSync(path.join(outDir, item.filename)));
      const released = JSON.parse(new TextDecoder().decode(files['manifest.json']));
      assert.equal(released.version, manifest.version);
      assert.ok(files['LICENSE']);
      assert.ok(files['THIRD_PARTY_NOTICES.md']);
      assert.ok(files['vendor/potion/model-i8.safetensors']);
      assert.ok(files['vendor/linkedom/worker.js']);
      assert.equal(files[item.browser === 'firefox' ? 'background.js' : 'background-firefox.js'], undefined);
      assert.deepEqual(Object.keys(files).sort(), Object.keys(item.files));
      assert.ok(!Object.keys(files).some(file => /(?:^|\/)(?:\.git|node_modules|\.verify-tmp|bench|experiments|tests|verification)(?:\/|$)/.test(file)));
      for (const file of [released.background.scripts?.[0] ?? released.background.service_worker, released.sidebar_action?.default_panel ?? released.side_panel.default_path, ...released.content_scripts.flatMap(script => script.js), ...Object.values(released.icons)]) assert.ok(files[file], `${file} is packaged`);
    }
    const source = unzipSync(readFileSync(path.join(outDir, `boilerspace-${manifest.version}-sources.zip`)));
    const sourceRoot = path.join(temporary, 'source');
    for (const [file, bytes] of Object.entries(source)) {
      const target = path.join(sourceRoot, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const rebuilt = spawnSync(process.execPath, ['scripts/build-release.mjs'], { cwd: sourceRoot, encoding: 'utf8', env: { ...process.env, TZ: 'Pacific/Honolulu' } });
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    for (const item of built) assert.deepEqual(readFileSync(path.join(sourceRoot, 'dist', item.filename)), readFileSync(path.join(outDir, item.filename)), 'source archive reproduces identical package bytes');
    writeFileSync(path.join(sourceRoot, 'extension', 'verification-seed.json'), '{"key":"do not distribute"}');
    const rejected = spawnSync(process.execPath, ['scripts/build-release.mjs'], { cwd: sourceRoot, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Unexpected file in extension/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
