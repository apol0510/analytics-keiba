/**
 * airtable SDK × esbuild の AbortSignal 改名事故の再発防止（2026-10-06）
 *
 * ## 何が起きたか
 *
 * #727 で airtableCallMeter.js に素の `AbortSignal.timeout(...)` を書いた。
 * Netlify Functions は esbuild で同梱されるため、同じ bundle に入る abort-controller の
 * `class AbortSignal` が、グローバル参照と衝突しないよう `AbortSignal2` に改名された。
 * airtable SDK 内の node-fetch v2 は `signal.constructor.name === 'AbortSignal'` で検査するので
 * 「Expected signal to be an instanceof AbortSignal」で **airtable SDK の全呼び出しが失敗**し、
 * auth-user / send-magic-link 等が 500 になって全会員がログインできなくなった。
 *
 * ## 固定すること
 *
 * 1. src / netlify の実装に素の `AbortSignal` 参照を書かない（`globalThis.AbortSignal` 経由のみ）
 * 2. airtable SDK を使う全 Function を本番と同じく esbuild で同梱し、改名が起きていないこと
 * 3. 実際に bundle を実行し、SDK が作る signal を node-fetch v2 が受け付けること
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FUNCTIONS_DIR = join(ROOT, 'netlify', 'functions');
const BARE_ABORT_SIGNAL = /(?<![.\w$])AbortSignal\b/;
const RENAMED_CLASS = /\bAbortSignal\d+\s*=\s*class\b/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js|ts)$/.test(name) && !/\.test\.|\.guard\./.test(name)) out.push(p);
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const sdkFunctions = readdirSync(FUNCTIONS_DIR)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => /require\(['"]airtable['"]\)|from ['"]airtable['"]/.test(readFileSync(join(FUNCTIONS_DIR, f), 'utf8')));

test('実装コードに素の AbortSignal 参照が無い（globalThis.AbortSignal 経由のみ）', () => {
  const offenders = [];
  for (const file of [...walk(join(ROOT, 'src')), ...walk(FUNCTIONS_DIR)]) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (BARE_ABORT_SIGNAL.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `素の AbortSignal 参照は esbuild 同梱で airtable SDK を壊す:\n${offenders.join('\n')}`);
});

test('airtable SDK を使う Function を esbuild 同梱しても AbortSignal が改名されない', async () => {
  assert.ok(sdkFunctions.length > 0, 'airtable SDK を使う Function が 0 件（検査の素通り）');
  assert.ok(sdkFunctions.includes('auth-user.js') && sdkFunctions.includes('send-magic-link.js'));
  const renamed = [];
  for (const f of sdkFunctions) {
    const res = await build({
      entryPoints: [join(FUNCTIONS_DIR, f)],
      bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      write: false, logLevel: 'silent',
    });
    if (RENAMED_CLASS.test(res.outputFiles[0].text)) renamed.push(f);
  }
  assert.deepEqual(renamed, [], `AbortSignal が改名された Function: ${renamed.join(', ')}`);
});

test('同梱後も airtable SDK の signal を node-fetch v2 が受け付ける（実行で確認）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ak-abortsignal-'));
  try {
    const entry = join(dir, 'entry.cjs');
    const req = createRequire(join(ROOT, 'package.json'));
    // airtable SDK が内部で使う node-fetch / abort-controller を SDK と同じ解決で同梱し、
    // 計測モジュール（素の AbortSignal を書いて事故を起こした場所）も同じ bundle に入れる
    writeFileSync(entry, `
      const AbortController = require(${JSON.stringify(req.resolve('airtable/lib/abort-controller.js'))});
      require(${JSON.stringify(join(ROOT, 'src/lib/ops/airtableCallMeter.js'))});
      require(${JSON.stringify(join(ROOT, 'src/lib/webhooks/emailEventLedgerWriter.js'))});
      module.exports = new AbortController().signal.constructor.name;
    `);
    const out = join(dir, 'out.cjs');
    await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: out, logLevel: 'silent' });
    const name = createRequire(out)(out);
    assert.equal(name, 'AbortSignal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
