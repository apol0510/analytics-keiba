/**
 * pausedHidesContent.guard.test.mjs
 *   販売停止 = **その会員に結果・商品内容を見せない**（UI だけでなくサーバー実効状態も）
 *
 * 2026-09-09 確定仕様 §4。停止中に URL 直打ち・API 直叩きで
 * 実績（結果）や商品内容が取れてしまうと、「見せたくない」という運営判断が成立しない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');
const MEDIA_FN = read('../../../netlify/functions/premium-plus-media.js');
const MEDIA_HANDLERS = read('./mediaHandlers.js');
const PRODUCT = read('../../pages/premium-plus-v2.astro');
const OLD_URL = read('../../pages/premium-plus.astro');

test('【重要】実績画像（media GET）は停止中の会員に返さない', () => {
  // ハンドラは会員ゲートを受け取り、通らなければ 404
  assert.match(MEDIA_HANDLERS, /memberGate/, 'handleMediaGet に会員ゲートが無い');
  assert.match(MEDIA_HANDLERS, /gate\.allowed !== true\) return notFound\(\)/,
    'ゲートを通らなくても 404 になっていない');
  // Function が停止を読んで渡している（判定は既存の単一源）
  assert.match(MEDIA_FN, /memberGate:/, 'Function が会員ゲートを渡していない');
  assert.match(MEDIA_FN, /salePaused === true\) return \{ allowed: false \}/,
    '停止中を弾いていない');
  assert.match(MEDIA_FN, /resolveUpsellForCustomer/, '停止判定を単一源から取っていない');
});

test('【重要】確認できないときは見せない（fail closed）', () => {
  assert.match(MEDIA_FN, /if \(!recordId\) return \{ allowed: false \}/);
  assert.match(MEDIA_FN, /if \(!fields\) return \{ allowed: false \}/);
  // 例外時も通さない
  assert.match(MEDIA_HANDLERS, /catch \{ gate = null; \}/);
});

test('停止判定を面ごとに再実装していない（単一源のみ）', () => {
  // 停止フラグを直接読む独自実装を足していないこと
  for (const [name, src] of [['media function', MEDIA_FN], ['media handlers', MEDIA_HANDLERS]]) {
    assert.ok(!/PremiumPlusSalePaused/.test(src),
      `${name} が Airtable 列を直読みしている（単一源を通していない）`);
  }
});

test('商品ページは停止中に商品内容を出さない（受付休止の案内のみ）', () => {
  assert.match(PRODUCT, /renderPauseNoticeHtml/, '受付休止ページの単一源を使っていない');
  assert.match(PRODUCT, /showProductPage/, '公開判定を通していない');
});

test('旧 URL も会員以外には 404（URL 直打ち対策）', () => {
  assert.match(OLD_URL, /verifyPlanAccess/);
  assert.match(OLD_URL, /status: 404/);
});
