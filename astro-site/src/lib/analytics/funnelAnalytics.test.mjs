/**
 * funnelAnalytics.test.mjs — 有料化ファネル計測の**振る舞い**を固定する
 *
 * `public/js/funnel-analytics.js` を実際に動かして確かめる
 * （`submissionHistoryOwner.test.mjs` と同じやり方）。読むだけの検査では
 * 「書いてあるが動かない」を見逃す。
 *
 * ここで守るのは 4 つ:
 *   1. 申込開始と申込成功を**混同しない**
 *   2. お問い合わせ・退会を申込成功に**数えない**
 *   3. 事故の二重送信を落とす（本物の再訪は落とさない）
 *   4. **個人情報を GA4 へ送らない**（閉じた語彙しか出ない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { derivePlanFromProductName } from '../payments/productName.js';

const SRC = readFileSync(
  fileURLToPath(new URL('../../../public/js/funnel-analytics.js', import.meta.url)), 'utf8');

/**
 * 公開 JS を偽の window で動かす。
 * `setInterval` は**何もしない**もので渡す（待ちループでテストが終わらなくなる）。
 */
function load({ openBankModal, SubmissionResult, withGtag = true } = {}) {
  const sent = [];
  const win = {};
  if (openBankModal) win.openBankModal = openBankModal;
  if (SubmissionResult) win.SubmissionResult = SubmissionResult;
  if (withGtag) {
    win.gtag = (kind, name, params) => { sent.push({ kind, name, params }); };
  }
  win.document = { addEventListener: () => {} };
  new Function('window', 'setInterval', 'clearInterval', SRC)(
    win, () => 0, () => {});
  return { win, AkFunnel: win.AkFunnel, sent };
}

/** 実際に `openBankModal(...)` へ渡されている商品名（src/pages から採取した実物）*/
const REAL_PLAN_NAMES = [
  ['Light - Campaign', 'monthly', 'Light', 'Monthly'],
  ['Light', 'monthly', 'Light', 'Monthly'],
  ['Premium 30日', 'monthly', 'Premium', 'Monthly'],
  ['Premium 30日 (Light会員アップグレード)', 'monthly', 'Premium', 'Monthly'],
  ['Premium Annual - Campaign', 'annual', 'Premium', 'Annual'],
  ['Premium Annual', 'annual', 'Premium', 'Annual'],
  ['Premium Lifetime - Spring Campaign', 'lifetime', 'Premium', 'Lifetime'],
  ['Premium Lifetime', 'lifetime', 'Premium', 'Lifetime'],
  ['Premium Monthly', 'monthly', 'Premium', 'Monthly'],
  ['Premium Plus', 'lifetime', 'Premium Plus', 'Lifetime'],
  ['Premium Sanrenpuku Lifetime', 'lifetime', 'Premium Sanrenpuku', 'Lifetime'],
  ['Premium 年払い', 'annual', 'Premium', 'Annual'],
  ['Premium 年払い (Light会員アップグレード)', 'annual', 'Premium', 'Annual'],
  ['Premium 買い切り', 'lifetime', 'Premium', 'Lifetime'],
  ['Premium 買い切り (Light会員アップグレード)', 'lifetime', 'Premium', 'Lifetime'],
];

test('実際に使われている商品名が、すべて閉じた語彙へ収まる', () => {
  const { AkFunnel } = load();
  for (const [name, type, plan, planType] of REAL_PLAN_NAMES) {
    assert.equal(AkFunnel.planLabel(name), plan, name);
    assert.equal(AkFunnel.planTypeLabel(type, name), planType, name);
    assert.ok(AkFunnel.PLAN_LABELS.includes(AkFunnel.planLabel(name)));
    assert.ok(AkFunnel.PLAN_TYPE_LABELS.includes(AkFunnel.planTypeLabel(type, name)));
  }
});

test('GA4 のプラン名は Airtable の RequestedPlan と同じ語彙になる', () => {
  // ⚠️ 片方だけ語彙が変わると、GA4 の申込数と Airtable の申込が突き合わせられない。
  //    `derivePlanFromProductName` が素直に読める商品名については必ず一致させる。
  const { AkFunnel } = load();
  for (const [name] of REAL_PLAN_NAMES) {
    const { planName } = derivePlanFromProductName(name);
    if (['Premium', 'Light', 'Premium Sanrenpuku', 'Premium Plus'].includes(planName)) {
      assert.equal(AkFunnel.planLabel(name), planName, name);
    }
  }
});

test('planType を渡さない呼び出し（2 引数）でも商品名から読む', () => {
  const { AkFunnel } = load();
  // archive-sanrenpuku-all / sanrenpuku-demo / withdrawal-upsell は 2 引数で呼ぶ
  assert.equal(AkFunnel.planTypeLabel(undefined, 'Premium Sanrenpuku Lifetime'), 'Lifetime');
  assert.equal(AkFunnel.planTypeLabel(undefined, 'Premium Plus'), 'Monthly');
  // 申込成功側が持っている形（金額つきの商品名）
  assert.equal(AkFunnel.planTypeLabel(null, 'Premium Annual - Campaign (¥44,820/年)'), 'Annual');
  assert.equal(AkFunnel.planTypeLabel(null, 'Premium 買い切り (¥78,000（永久アクセス）)'), 'Lifetime');
  assert.equal(AkFunnel.planTypeLabel(null, 'Light (¥4,980/30日)'), 'Monthly');
});

test('申込開始と申込成功は別のイベント名で出る', () => {
  const { AkFunnel, sent } = load();
  AkFunnel.applicationStart('Premium Annual', 'annual');
  AkFunnel.applicationSubmitted('Premium Annual', 'annual');
  assert.deepEqual(sent.map((s) => s.name), ['application_start', 'application_submitted']);
  assert.deepEqual(sent[0].params, { plan: 'Premium', plan_type: 'Annual' });
});

test('モーダルを開くと申込開始が出る（ページ側のコードは触らない）', () => {
  const calls = [];
  const openBankModal = function (...args) { calls.push(args); return 'original-return'; };
  const { win, sent } = load({ openBankModal });
  const out = win.openBankModal('Premium Sanrenpuku Lifetime', 78000, 'lifetime');
  // 元の関数はそのまま呼ばれ、戻り値も壊さない
  assert.equal(out, 'original-return');
  assert.deepEqual(calls, [['Premium Sanrenpuku Lifetime', 78000, 'lifetime']]);
  assert.deepEqual(sent, [{
    kind: 'event',
    name: 'application_start',
    params: { plan: 'Premium Sanrenpuku', plan_type: 'Lifetime' },
  }]);
});

test('モーダルを開いただけでは申込成功にならない', () => {
  const { win, sent } = load({ openBankModal: () => {} });
  win.openBankModal('Premium Lifetime', 78000, 'lifetime');
  assert.equal(sent.filter((s) => s.name === 'application_submitted').length, 0);
});

/** 成功画面の共通処理（12 ページが通る道）の最小スタブ */
function makeSubmissionResult(log) {
  return { showSuccessScreen: (opts) => { log.push(opts); return 'sr-return'; } };
}

test('サーバー受理後の成功画面で申込成功が出る', () => {
  const log = [];
  const { win, sent } = load({ SubmissionResult: makeSubmissionResult(log) });
  const out = win.SubmissionResult.showSuccessScreen({
    history: {
      type: 'bank-transfer',
      label: '銀行振込お申し込み: Premium Annual - Campaign (¥44,820/年)',
      details: {
        email: 'customer@example.com',
        productName: 'Premium Annual - Campaign (¥44,820/年)',
        transferAmount: '44820',
        transferDate: '2026-09-18',
      },
    },
  });
  assert.equal(out, 'sr-return');
  assert.equal(log.length, 1, '元の成功画面は必ず出る');
  assert.deepEqual(sent, [{
    kind: 'event',
    name: 'application_submitted',
    params: { plan: 'Premium', plan_type: 'Annual' },
  }]);
});

test('お問い合わせ・退会・Premium Plus の問い合わせは申込成功に数えない', () => {
  for (const type of ['contact', 'premium-plus-contact', 'withdrawal', 'submission', '']) {
    const { win, sent } = load({ SubmissionResult: makeSubmissionResult([]) });
    win.SubmissionResult.showSuccessScreen({
      history: { type, label: 'お問い合わせ', details: { email: 'a@example.com' } },
    });
    assert.deepEqual(sent, [], `type=${type} は申込ではない`);
  }
});

test('GA4 へ送る値に個人情報が混ざらない', () => {
  const { win, sent } = load({ SubmissionResult: makeSubmissionResult([]) });
  // 商品名に個人情報が紛れ込んだ最悪ケースでも、閉じた語彙に落ちる
  win.SubmissionResult.showSuccessScreen({
    history: {
      type: 'bank-transfer',
      details: {
        email: 'leak@example.com',
        fullName: '山田太郎',
        productName: 'leak@example.com 山田太郎 rec123456 (¥78,000)',
      },
    },
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0].params).sort(), ['plan', 'plan_type']);
  assert.equal(sent[0].params.plan, 'other', '知らない文字列はそのまま送らない');
  const blob = JSON.stringify(sent);
  for (const pii of ['leak@example.com', '山田太郎', 'rec123456', '78,000', '78000']) {
    assert.ok(!blob.includes(pii), `${pii} が GA4 へ出ている`);
  }
});

test('金額・振込日・メールは引数に取らない（送りようがない）', () => {
  const { AkFunnel, sent } = load();
  // openBankModal の第 2 引数（金額）は包み込みで捨てている
  AkFunnel.applicationStart('Premium Lifetime', 'lifetime');
  assert.deepEqual(Object.keys(sent[0].params).sort(), ['plan', 'plan_type']);
});

test('事故の二重送信は落ちるが、時間をおいた再訪は落ちない', () => {
  const { AkFunnel, sent } = load();
  AkFunnel.applicationSubmitted('Premium Lifetime', 'lifetime');
  AkFunnel.applicationSubmitted('Premium Lifetime', 'lifetime'); // 同じハンドラが二重登録された想定
  assert.equal(sent.length, 1, '2 秒以内の同一イベントは 1 回だけ');

  // 別プランは別物として通す
  AkFunnel.applicationSubmitted('Light', 'monthly');
  assert.equal(sent.length, 2);

  // 時間が経てば本物の再訪として通す
  AkFunnel._reset();
  AkFunnel.applicationSubmitted('Premium Lifetime', 'lifetime');
  assert.equal(sent.length, 3);
});

test('包み込みは 2 度かからない（イベントが倍にならない）', () => {
  const { win, AkFunnel, sent } = load({
    openBankModal: () => {}, SubmissionResult: makeSubmissionResult([]),
  });
  AkFunnel._install();
  AkFunnel._install();
  win.openBankModal('Premium Lifetime', 78000, 'lifetime');
  assert.equal(sent.length, 1);
});

test('gtag が無くても申込を壊さない', () => {
  const calls = [];
  const { win } = load({
    withGtag: false,
    openBankModal: () => { calls.push(1); },
    SubmissionResult: makeSubmissionResult([]),
  });
  assert.doesNotThrow(() => win.openBankModal('Premium Lifetime', 78000, 'lifetime'));
  assert.doesNotThrow(() => win.SubmissionResult.showSuccessScreen({
    history: { type: 'bank-transfer', details: { productName: 'Premium Lifetime' } },
  }));
  assert.equal(calls.length, 1, 'gtag が無くてもモーダルは開く');
});

test('gtag が投げても申込を止めない', () => {
  const { win } = load({ openBankModal: () => {} });
  win.gtag = () => { throw new Error('blocked'); };
  assert.doesNotThrow(() => win.openBankModal('Premium Lifetime', 78000, 'lifetime'));
});
