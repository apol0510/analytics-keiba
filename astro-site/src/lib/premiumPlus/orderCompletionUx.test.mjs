/**
 * orderCompletionUx.test.mjs — 申込画面の「金額」と「送信後」を固定する
 *
 * ## 直した 2 つの障害（2026-08-23 / MK 報告）
 *
 * 1. **「クーポン適用前も適用後も金額の変化が見られない」**
 *    金額は 4 か所に出るのに、更新していたのは内訳と readonly 入力の 2 か所だけだった。
 *    お客様が実際に読む「振込金額」と手順の金額は通常価格のまま。
 *    → **振り込む額が画面ごとに食い違う**＝誤った額の振込に直結する。
 *
 * 2. **「送信した後も同じ画面。ありがとうメッセージや遷移は？」**
 *    送信後に隠していたのは `<form>` だけで、口座番号・振込手順・クーポン欄が残っていた。
 *    完了パネルは出ていても、画面全体は申込中と同じに見える。
 *
 * ## この機能に共通する原則
 *
 * **操作の結果が画面に出るところまでが実装。** 送信できたのか、いくら払うのかが
 * 画面から読み取れないなら、サーバーが正しくても機能は完成していない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PAGES = ['../../pages/premium-plus.astro', '../../pages/premium-plus-v2.astro'];
const COUPON_UI = read('../../components/PremiumPlusCouponApply.astro');

// ── 金額はすべて同じ値へ揃う ────────────────────────────────
test('金額を出す要素はすべて id を持つ（更新漏れを作らない）', () => {
  for (const p of PAGES) {
    const src = read(p);
    assert.match(src, /id="ppPayAmountBank"/, `${p}: 振込金額の表示に id が無い`);
    assert.match(src, /id="ppPayAmountStep"/, `${p}: 手順の金額に id が無い`);
    assert.match(src, /id="transferAmount"/, `${p}: 送信する金額欄が無い`);
  }
});

test('クーポン適用時に、金額を出す 3 か所すべてを更新する', () => {
  for (const id of ['ppPayAmountBank', 'ppPayAmountStep', 'transferAmount']) {
    assert.ok(COUPON_UI.includes(id), `${id} を更新していない（表示が食い違う）`);
  }
});

test('金額は必ずサーバーの値。画面で計算しない', () => {
  // 内訳・表示ともサーバーが作った文字列 / 数値をそのまま使う
  assert.match(COUPON_UI, /b\.finalText/, 'お支払い金額をサーバー文字列から取っていない');
  assert.match(COUPON_UI, /p\.finalPrice/, '送信する金額をサーバー値から取っていない');
  // 画面で割り引く・足し引きする実装を持たない
  assert.doesNotMatch(COUPON_UI, /regularPrice\s*-\s*|\*\s*0\.\d/, '画面で金額を計算している');
  assert.doesNotMatch(COUPON_UI, /68,?000|58,?000|10,?000/, '金額を直書きしている');
});

// ── 送信後は「申込の画面」を残さない ────────────────────────
test('送信後、口座・手順・クーポン欄を残さない（同じ画面に見せない）', () => {
  for (const p of PAGES) {
    const src = read(p);
    const done = src.slice(src.indexOf('const doneHide'));
    assert.ok(done.startsWith('const doneHide'), `${p}: 完了時に隠す要素を決めていない`);
    const head = done.slice(0, 400);
    for (const sel of ['.modal-title', '.bank-box', '.steps-box', 'ppCouponBlock']) {
      assert.ok(head.includes(sel), `${p}: 送信後も ${sel} が残る`);
    }
    assert.match(src, /hideEls: doneHide/, `${p}: 隠す指定を完了画面へ渡していない`);
  }
});

test('お礼と次の行き先を必ず出す', () => {
  for (const p of PAGES) {
    const src = read(p);
    assert.match(src, /showSuccessScreen\(/, `${p}: 完了画面を出していない`);
    assert.match(src, /ありがとうございます/, `${p}: お礼が無い`);
  }
  // 次の行き先（マイページ / トップ）は共通部品が必ず描く
  const helper = readFileSync(
    fileURLToPath(new URL('../../../public/js/submission-result.js', import.meta.url)), 'utf8');
  assert.match(helper, /\/dashboard\//, '次の行き先が無い');
  assert.match(helper, /submission-success-actions/);
});

test('送信に失敗したときは完了画面を出さない（成功と取り違えない）', () => {
  for (const p of PAGES) {
    const src = read(p);
    const i = src.indexOf('showSuccessScreen');
    const before = src.slice(Math.max(0, i - 1200), i);
    assert.match(before, /if \(!response\.ok\) throw new Error/,
      `${p}: 失敗しても完了画面が出る`);
  }
});
