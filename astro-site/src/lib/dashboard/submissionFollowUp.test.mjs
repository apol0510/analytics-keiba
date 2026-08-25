/**
 * submissionFollowUp.test.mjs — 「このあとどうなるか」は商品ごとに違う
 *
 * ## 2026-08-26 MK 指摘
 *
 * > Premium Plus だけは単品購入なので会員ステータスには反映されない。文言が合わない商品
 *
 * そのとおりだった。履歴の案内は「上の会員ステータスでご確認いただけます」と
 * **一律**に書いていたが、Premium Plus は単品購入で
 * `confirm-bank-payment` のプラン昇格経路を通らず、**会員ステータスは一切変わらない**
 * （買い目は入金確認後に個別にお届けする運用。docs/PREMIUM_PLUS.md）。
 *
 * ⚠️ 文言は**送信完了画面と履歴の 2 か所**に出る。別々に書くと必ず食い違うので、
 *    判定も文言も `/js/submission-result.js` の 1 か所に置く。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');

/** 公開 JS（IIFE）をそのまま動かして、**実際の戻り値**を見る */
function loadSubmissionResult() {
  const src = read('../../../public/js/submission-result.js');
  const win = {};
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  new Function('window', 'localStorage', 'document', src)(win, storage, { getElementById: () => null });
  assert.ok(win.SubmissionResult, '公開できていない');
  return win.SubmissionResult;
}
const SR = loadSubmissionResult();

const plus = (over = {}) => ({
  type: 'bank-transfer', status: 'pending',
  label: '銀行振込お申し込み: Premium Plus 8月23日分 (¥68,000)',
  details: { productName: 'Premium Plus 8月23日分' }, ...over,
});
const plan = (over = {}) => ({
  type: 'bank-transfer', status: 'pending',
  label: '銀行振込お申し込み: Premium 年額 (¥44,800)', details: {}, ...over,
});

test('Premium Plus は「会員ステータスに反映される」と言わない', () => {
  const t = SR.describeFollowUp(plus());
  assert.ok(t, '案内が空');
  assert.ok(!/上の会員ステータスに反映/.test(t), '単品なのにプランと同じ案内を出している');
  assert.match(t, /メールでご案内/, '実際の届け方（メール）を書いていない');
  assert.match(t, /反映されません/, '会員ステータスが変わらないことを伝えていない');
});

test('プランのお申し込みは会員ステータスに反映されると案内する', () => {
  assert.match(SR.describeFollowUp(plan()), /上の会員ステータスに反映されます/);
});

test('商品名が無くてもラベルから Premium Plus を見分ける（古い記録の救済）', () => {
  const old = { type: 'bank-transfer', status: 'pending', label: '銀行振込お申し込み: Premium Plus 8月23日分' };
  assert.equal(SR.isPremiumPlusOrder(old), true);
  assert.match(SR.describeFollowUp(old), /反映されません/);
});

test('Premium / Premium Sanrenpuku を Plus と取り違えない', () => {
  for (const name of ['Premium 年額', 'Premium Sanrenpuku Lifetime', 'Light 月額']) {
    assert.equal(SR.isPremiumPlusOrder({ label: '銀行振込お申し込み: ' + name }), false, name);
  }
});

test('送信できなかった記録には「このあと」を出さない', () => {
  assert.equal(SR.describeFollowUp(plus({ status: 'failed' })), '');
  assert.equal(SR.describeFollowUp(plan({ status: 'failed' })), '');
});

test('お問い合わせなど、入金の無いものには出さない', () => {
  for (const type of ['contact', 'magic-link', 'withdrawal', 'submission']) {
    assert.equal(SR.describeFollowUp({ type, status: 'sent' }), '', type);
  }
  assert.equal(SR.describeFollowUp(undefined), '');
});

test('状態名は更新されない記録でも嘘にならない言葉だけ', () => {
  assert.deepEqual(SR.describeStatus({ status: 'pending' }), { label: '送信しました', className: 'status-pending' });
  assert.deepEqual(SR.describeStatus({ status: 'sent' }), { label: '送信しました', className: 'status-sent' });
  assert.equal(SR.describeStatus({ status: 'failed' }).label, '送信できませんでした');
});

// ── 2 か所で食い違わせない ──────────────────────────────
test('マイページは文言を自分で組み立てない（単一源を呼ぶ）', () => {
  const page = read('../../pages/dashboard.astro');
  const i = page.indexOf('listEl.innerHTML = history.map');
  const body = page.slice(i, i + 1400);
  assert.match(body, /SR\.describeStatus/, '状態名を単一源から取っていない');
  assert.match(body, /SR\.describeFollowUp/, '案内文を単一源から取っていない');
  assert.ok(!body.includes('会員ステータス'), 'ページ側で案内文を書いている');
});

test('Premium Plus の送信完了画面もマイページで確認できるとは言わない', () => {
  for (const rel of ['../../pages/premium-plus.astro', '../../pages/premium-plus-v2.astro']) {
    const src = read(rel);
    const code = src.replace(/\/\/[^\n]*/g, '');
    assert.ok(!code.includes('お申し込みの状況はマイページからご確認いただけます'),
      `${rel}: 単品購入なのにマイページで確認できると案内している`);
    assert.match(code, /買い目の配信についてメールでご案内します/, `${rel}: 実際の届け方が書かれていない`);
  }
});

test('古い /js/submission-result.js が残っていても履歴を壊さない', () => {
  // ハッシュ無しの URL なのでブラウザに古い版が残りうる
  const page = read('../../pages/dashboard.astro');
  const i = page.indexOf('listEl.innerHTML = history.map');
  const body = page.slice(i, i + 1400);
  assert.match(body, /SR\.describeStatus \?/, '関数が無い場合に落ちる');
  assert.match(body, /SR\.describeFollowUp \?/, '関数が無い場合に落ちる');
});
