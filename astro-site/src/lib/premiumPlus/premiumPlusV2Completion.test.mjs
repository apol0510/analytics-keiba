/**
 * premiumPlusV2Completion.test.mjs — 申込画面の「完了画面」と「金額の一致」を固定する
 *
 * CLAUDE.md「言われなくても必ずやること」9・10 の guard。
 *
 * 実際に起きた不具合:
 *   - クーポンを適用しても銀行振込ブロックの振込金額が割引前のままで、
 *     「お支払い金額（割引後）」と食い違ったまま客に出ていた。
 *   - 送信してもフォームが隠れるだけで、上のクーポン欄・口座情報・手順が残るため
 *     「画面が変わらない／お礼が出ない」状態だった。
 *
 * どちらも**画面を実際に触らないと気づけない**種類なので、構造として固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PAGE = read('../../pages/premium-plus-v2.astro');
const COUPON_UI = read('../../components/PremiumPlusCouponApply.astro');

test('振込金額の表示は id を持ち、クーポン適用で差し替えられる', () => {
  // 表示側（振込金額・お申し込み手順）に id が付いていること
  assert.match(PAGE, /id="ppTransferAmountText"/, '振込金額の表示に id が無い');
  assert.match(PAGE, /id="ppTransferAmountStep"/, 'お申し込み手順の金額に id が無い');

  // クーポン適用時に両方を更新していること
  assert.match(COUPON_UI, /setText\('ppTransferAmountText'/, '振込金額の表示を更新していない');
  assert.match(COUPON_UI, /setText\('ppTransferAmountStep'/, '手順の金額を更新していない');

  // 更新値はサーバーが返した文字列をそのまま使う（画面で組み立てない）
  assert.match(COUPON_UI, /b\.transferText/, 'サーバーの確定表示を使っていない');
  assert.doesNotMatch(COUPON_UI, /toLocaleString/, '画面で金額を整形している');
});

test('サーバーは振込金額の表示文字列を返す', () => {
  const lib = read('./premiumPlusCouponApply.js');
  assert.match(lib, /transferText:/, 'breakdown に transferText が無い');
});

test('送信成功時は完了画面へ差し替え、周囲の案内を残さない', () => {
  const success = PAGE.slice(PAGE.indexOf('showSuccessScreen'));

  // フォームだけでなく、周囲の案内も隠すこと
  assert.match(success, /hideEls:/, '完了時に周囲の案内を隠していない');
  for (const sel of ['.modal-title', 'ppCouponBlock', '.bank-box', '.steps-box', '.warning-box']) {
    assert.ok(
      PAGE.includes(sel),
      `完了時に隠す対象 ${sel} が見つからない（構成が変わったなら hideEls も直すこと）`,
    );
  }
});

test('完了画面はお礼を述べる', () => {
  assert.match(PAGE, /title: 'お申し込みありがとうございます'/, '完了画面にお礼が無い');
});

test('完了後はモーダル先頭へ戻して完了画面を見せる', () => {
  assert.match(PAGE, /modal-content['"]\)[\s\S]{0,200}scrollTo/, '完了画面までスクロールしていない');
});
