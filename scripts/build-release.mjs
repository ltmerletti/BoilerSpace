import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from '../extension/vendor/fflate/fflate.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// ZIP stores local calendar fields, not a UTC instant.
const ZIP_DATE = new Date(2026, 0, 1, 0, 0, 0);
const ROOT_FILES = new Set(['COPYING', 'NOTICE', 'manifest.json', 'background.js', 'background-firefox.js', 'content.js', 'sidepanel.html', 'sidepanel.js', 'sidepanel.css', 'document.html', 'document.js', 'document.css']);

function runtimeFile(file) {
  return ROOT_FILES.has(file)
    || /^lib\/[a-z-]+\.js$/.test(file)
    || /^icons\/(?:icon(?:16|32|48|128)\.png|logo\.svg)$/.test(file)
    || /^fonts\/(?:[a-zA-Z0-9_-]+\.woff2|OFL\.txt)$/.test(file)
    || /^vendor\/(?:fflate\/(?:fflate\.js|LICENSE)|tokenizers\/(?:tokenizers\.mjs|LICENSE)|linkedom\/(?:worker\.js|LICENSE|NOTICE\.md|PROVENANCE\.md)|potion\/(?:model-i8\.safetensors|tokenizer\.json|LICENSE|MODEL_CARD\.md|PROVENANCE\.md)|pdfjs\/(?:pdf(?:\.worker)?\.min\.mjs|LICENSE|cmaps\/(?:[a-zA-Z0-9_-]+\.bcmap|LICENSE)|standard_fonts\/(?:LICENSE_(?:FOXIT|LIBERATION)|[a-zA-Z0-9_-]+\.(?:pfb|ttf))))$/.test(file);
}

function readTree(directory, prefix = '') {
  const entries = {};
  for (const name of readdirSync(path.join(directory, prefix)).sort()) {
    const file = path.posix.join(prefix, name);
    const location = path.join(directory, file);
    const stat = lstatSync(location);
    if (stat.isSymbolicLink()) throw new Error(`Release files cannot be symlinks: ${file}`);
    if (stat.isDirectory()) Object.assign(entries, readTree(directory, file));
    else {
      if (!runtimeFile(file)) throw new Error(`Unexpected file in extension/: ${file}`);
      entries[file] = new Uint8Array(readFileSync(location));
    }
  }
  return entries;
}

export function browserManifest(source, browser) {
  const manifest = structuredClone(source);
  if (browser === 'firefox') {
    delete manifest.minimum_chrome_version;
    delete manifest.side_panel;
    delete manifest.background.service_worker;
    manifest.permissions = manifest.permissions.filter(permission => permission !== 'sidePanel');
  } else if (browser === 'chrome') {
    delete manifest.browser_specific_settings;
    delete manifest.sidebar_action;
    delete manifest.background.scripts;
  } else throw new Error(`Unknown release browser: ${browser}`);
  return manifest;
}

function archive(files) {
  return zipSync(Object.fromEntries(Object.keys(files).sort().map(file => [file, [files[file], { mtime: ZIP_DATE, level: 6 }]])));
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function buildRelease({ root = ROOT, outDir = path.join(root, 'dist'), browsers = ['firefox', 'chrome'] } = {}) {
  const source = readTree(path.join(root, 'extension'));
  const manifest = JSON.parse(new TextDecoder().decode(source['manifest.json']));
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
  if (manifest.version !== pkg.version) throw new Error('Manifest and package versions differ.');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Release version must be major.minor.patch.');
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const browser of browsers) {
    const files = { ...source };
    delete files[browser === 'firefox' ? 'background.js' : 'background-firefox.js'];
    files['manifest.json'] = new TextEncoder().encode(JSON.stringify(browserManifest(manifest, browser), null, 2) + '\n');
    files['LICENSE'] = new Uint8Array(readFileSync(path.join(root, 'LICENSE')));
    files['THIRD_PARTY_NOTICES.md'] = new TextEncoder().encode(readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').replaceAll('](extension/', ']('));
    const destination = path.join(outDir, browser);
    rmSync(destination, { recursive: true, force: true });
    for (const [file, bytes] of Object.entries(files)) {
      const location = path.join(destination, file);
      mkdirSync(path.dirname(location), { recursive: true });
      writeFileSync(location, bytes);
    }
    const bytes = archive(files);
    const filename = `boilerspace-${manifest.version}-${browser}.zip`;
    writeFileSync(path.join(outDir, filename), bytes);
    results.push({ browser, filename, bytes: bytes.length, sha256: hash(bytes), files: Object.fromEntries(Object.keys(files).sort().map(file => [file, hash(files[file])])) });
  }
  // Include only files needed to rebuild the packages, not the whole working tree.
  const sources = Object.fromEntries(Object.entries(source).map(([file, bytes]) => [`extension/${file}`, bytes]));
  for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'SECURITY.md', 'scripts/build-release.mjs', 'scripts/lint-release.mjs', 'experiments/discussions/quantize-potion.mjs', 'docs/RELEASE.md']) {
    sources[file] = new Uint8Array(readFileSync(path.join(root, file)));
  }
  sources['README.md'] = sources['docs/RELEASE.md'];
  writeFileSync(path.join(outDir, `boilerspace-${manifest.version}-sources.zip`), archive(sources));
  writeFileSync(path.join(outDir, 'checksums.json'), JSON.stringify({ version: manifest.version, packages: results }, null, 2) + '\n');
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const result of buildRelease()) console.log(`${result.filename}  ${(result.bytes / 1_000_000).toFixed(1)} MB  ${result.sha256}`);
}
