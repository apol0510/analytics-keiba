/**
 * stageTeaserWiring.guard.test.mjs — 三連複ページの導線コンポーネントの構造 guard
 *
 * `PremiumPlusStageTeaser.astro` の `<script is:inline>` は
 * **未ログイン者の HTML にもそのまま載る**。ここに Premium Plus の文言を書くと、
 * ソースを見るだけで商品の存在・停止理由・クーポンの条件が読めてしまう。
 *
 * 固定すること:
 *   - 停止中は `preventDefault()` で**遷移させない**（押す前は普通の導線に見える）
 *   - 停止判定は**サーバー**（`data.paused`）。クライアントで組み立てない
 *   - 案内・クーポンの文言を 1 文字もクライアントへ書かない
 *   - 受け取れたかは**サーバーの応答**で決める（押した瞬間に「取得済み」と言わない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  fileURLToPath(new URL('../../components/PremiumPlusStageTeaser.astro', import.meta.url)),
  'utf8',
);
const SCRIPT = SRC.slice(SRC.indexOf('<script is:inline>'));

test('停止中は遷移させない（押した先でご案内する）', () => {
  assert.match(SCRIPT, /data\.paused === true/, '停止判定をサーバーの値で見ていない');
  assert.match(SCRIPT, /preventDefault\(\)/, '遷移を止めていない');
  assert.match(SCRIPT, /openNotice\(/, '押した先の案内を開いていない');
});

test('押す前の見た目は通常の導線のまま', () => {
  // link 生成 → その後に停止時のクリック抑止、という順序であること
  const link = SCRIPT.indexOf("link.className = 'pp-stage-link'");
  const guard = SCRIPT.indexOf('data.paused === true');
  assert.ok(link > 0 && guard > link, '停止中だけリンクの見た目を変えている');
  assert.doesNotMatch(SCRIPT, /paused[^\n]*linkLabel\s*=/, '停止中だけラベルを差し替えている');
});

test('文言をクライアントへ書かない（未ログイン者の HTML に載る）', () => {
  const BANNED = [
    '殺到', 'クーポン', 'Premium Plus', 'プレミアム', '割引', '円OFF', '68,000', '58,000',
    '受け取', '優待', '販売', '停止',
  ];
  for (const w of BANNED) {
    assert.ok(!SCRIPT.includes(w), `inline script に「${w}」が書かれている`);
  }
});

test('文言はすべてサーバー由来の値から読む', () => {
  for (const k of ['n.title', 'n.body', 'n.couponLead', 'n.couponAsk', 'n.claimLabel']) {
    assert.ok(SCRIPT.includes(k), `${k} を使っていない`);
  }
  // textContent だけを使う（innerHTML でサーバー文字列を注入しない）
  assert.doesNotMatch(SCRIPT, /innerHTML/, 'innerHTML を使っている');
});

test('受け取れたかはサーバーの応答だけで決める', () => {
  assert.match(SCRIPT, /'\/api\/premium-plus-coupon\.json'/);
  assert.match(SCRIPT, /method: 'POST'/, 'GET で取得しようとしている');
  assert.match(SCRIPT, /j\.claimed !== true/, '応答を確認せず「取得済み」にしている');
});

test('この枠から購入・課金を起こさない', () => {
  for (const w of ['stripe', 'checkout', 'order', 'payment', 'confirm-bank']) {
    assert.ok(!SCRIPT.toLowerCase().includes(w), `inline script が ${w} に触れている`);
  }
});
