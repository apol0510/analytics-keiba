/**
 * weakClaims.guard.test.mjs — 訴求に使わない言い回し（MK 指摘で外したものを再発させない）
 *
 * 正本: docs/PREDICTION_ACQUISITION.md §6-1「訴求に使わない言い回し」。
 * 顧客向けの画面（src/pages・src/components・src/layouts）と配信メールの文面（src/lib/marketing）を見る。
 * コメントは対象外。新しく足すときは正本の表にも理由を書く。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../../', import.meta.url).pathname;

/** [言い回し, 理由（MK の指摘）] */
export const WEAK_CLAIMS = [
  [/見返せ|見返す/, '「いつでも見返せる」はメリットに見えない（2026-10-05）'],
  [/月額の範囲/, '制限があるように見える。「月額料金だけで・追加料金なし・取得し放題」と言う（2026-10-05）'],
];

function files(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, exts));
    else if (exts.some((e) => name.endsWith(e)) && !/\.test\.|\.guard\./.test(name)) out.push(p);
  }
  return out;
}
const stripComments = (s) => s
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:'"`])\/\/[^\n'"`]*$/gm, '$1');

test('訴求に使わない言い回しが画面・配信文面に無い（正本 PREDICTION_ACQUISITION.md §6-1）', () => {
  const targets = [
    ...files(join(SRC, 'pages'), ['.astro', '.js']),
    ...files(join(SRC, 'components'), ['.astro']),
    ...files(join(SRC, 'layouts'), ['.astro']),
    ...files(join(SRC, 'lib/marketing'), ['.js']),
  ];
  const hits = [];
  for (const f of targets) {
    const text = stripComments(readFileSync(f, 'utf8'));
    for (const [re, why] of WEAK_CLAIMS) if (re.test(text)) hits.push(`${relative(SRC, f)}: ${re} — ${why}`);
  }
  assert.deepEqual(hits, []);
});
