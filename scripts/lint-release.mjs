import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
const archive = path.join(root, 'dist', `boilerspace-${pkg.version}-firefox.zip`);
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/addons-linter/bin/addons-linter'), archive, '--output=json'], { encoding: 'utf8', maxBuffer: 10_000_000 });
if (result.error) throw result.error;
if (!result.stdout) throw new Error(result.stderr || 'The Mozilla validator returned no report.');
const report = JSON.parse(result.stdout);
mkdirSync(path.join(root, 'dist'), { recursive: true });
writeFileSync(path.join(root, 'dist', 'firefox-lint.json'), JSON.stringify(report, null, 2) + '\n');
// These upstream/static-template warnings are documented for the AMO reviewer.
// New files or warning categories must be reviewed instead of silently accepted.
const reviewed = new Map([
  // No gecko_android key: this release is desktop-only. The linter still
  // compares native consent against Android's default minimum (140 vs 142).
  ['manifest.json', new Set(['KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION'])],
  ['content.js', new Set(['UNSAFE_VAR_ASSIGNMENT'])],
  ['vendor/linkedom/worker.js', new Set(['UNSAFE_VAR_ASSIGNMENT'])],
  ['vendor/pdfjs/pdf.min.mjs', new Set(['DANGEROUS_EVAL', 'UNSAFE_VAR_ASSIGNMENT'])],
  ['vendor/pdfjs/pdf.worker.min.mjs', new Set(['DANGEROUS_EVAL', 'UNSAFE_VAR_ASSIGNMENT'])],
]);
const unexpected = (report.warnings ?? []).filter(warning => !reviewed.get(warning.file)?.has(warning.code));
if (report.warnings.length > 11) unexpected.push({ file: 'release package', code: 'WARNING_COUNT_INCREASED', message: 'More warnings than the reviewed v1 baseline (11).' });
console.log(`Mozilla validator: ${report.errors.length} errors, ${report.warnings.length} warnings (${unexpected.length} unreviewed). Full report: dist/firefox-lint.json`);
for (const issue of [...report.errors, ...unexpected]) console.error(`${issue.file}: ${issue.code}: ${issue.message}`);
if (report.errors.length || unexpected.length || result.status) process.exitCode = 1;
