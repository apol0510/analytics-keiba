/**
 * drmAttributionFunction.guard.test.mjs — 購入帰属 Function をソースで固定する
 *
 * ── なぜ分けたのか ────────────────────────────────────────────
 * 購入帰属には「いつ有料になったか」（`bankPaymentFlow` が書く入金確認時刻）が要る。
 * ところが `offerCampaignFunction.guard.test.mjs` は**送信経路**
 * （`admin-marketing.js` / `marketing-campaign-dispatch.js`）が決済メール v2 の
 * フィールドへ触れないことを守っている。その契約は**緩めない**。
 *
 * そこで**分析専用の Function だけ**が購入確定時刻を読む形へ責務を分けた。
 * このテストは「分けた意味が後から壊れない」ことを固定する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function read(rel) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', '..', '..', rel), 'utf8');
}
/** コメントを除いた実コードだけを見る */
function strip(src) {
  return src.split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join('\n');
}

const FN = 'netlify/functions/admin-drm-attribution.js';
const raw = read(FN);
const code = strip(raw);
const adminMarketing = strip(read('netlify/functions/admin-marketing.js'));
const dispatch = strip(read('netlify/functions/marketing-campaign-dispatch.js'));

// ── 1. 送信経路の guard を弱めていない ────────────────────────
test('【重要】送信経路は決済メール v2 のフィールドへ触れないまま', () => {
  for (const [name, src] of [['admin-marketing', adminMarketing], ['dispatch', dispatch]]) {
    for (const banned of ['PaymentEmailSent', 'PaymentEmailStatus', 'PaymentEmailIdempotencyKey',
      'PaymentConfirmed', 'PaidAt', '有効期限']) {
      assert.equal(src.includes(banned), false, `${name}: ${banned} を持ち込んでいる`);
    }
  }
});

test('【重要】既存 guard の禁止語リストを削っていない', () => {
  const guard = read('src/lib/promotions/offerCampaignFunction.guard.test.mjs');
  for (const banned of ['PaymentEmailSent', 'PaymentEmailStatus', 'PaymentEmailIdempotencyKey',
    'PaymentConfirmed', 'PaidAt', '有効期限']) {
    assert.ok(guard.includes(`'${banned}'`), `禁止語 ${banned} が guard から消えている`);
  }
});

// ── 2. 書き込み・送信を一切しない ─────────────────────────────
test('【重要】Customers へ書き込まない（POST / PATCH / PUT / DELETE なし）', () => {
  for (const m of ["method: 'POST'", "method: 'PATCH'", "method: 'PUT'", "method: 'DELETE'",
    'createRecord', 'patchRecord', 'upsertDeliveries']) {
    assert.equal(code.includes(m), false, `書き込み（${m}）をしている`);
  }
});

test('【重要】queue 登録・dispatch 呼び出し・メール送信をしない', () => {
  for (const m of ['sendgrid', 'SENDGRID', 'dispatch-background', 'marketing-campaign-dispatch',
    'buildScheduledEmailFields', 'ScheduledEmails', 'renderCampaign']) {
    assert.equal(code.includes(m), false, `送信系（${m}）に触れている`);
  }
});

test('【重要】PromotionalOffers へ書き込まない', () => {
  assert.equal(code.includes('OFFERS_TABLE'), false, '割引台帳に触れている');
  assert.equal(code.includes('PromotionalOffers'), false, '割引台帳に触れている');
});

// ── 3. 認証・入力の bounded 性 ───────────────────────────────
test('【重要】未認証では読めない', () => {
  assert.ok(/x-admin-secret/.test(code), '認証ヘッダを見ていない');
  assert.ok(/provided !== SECRET/.test(code), 'secret を検証していない');
  assert.ok(/return json\(403/.test(code), '不一致で 403 にしていない');
  assert.ok(/if \(!SECRET\) return json\(503/.test(code), 'secret 未設定で無効化していない');
});

test('【重要】入力は bounded（全 Customers 走査をしない）', () => {
  assert.ok(/MAX_RECORD_IDS/.test(code), '件数上限が無い');
  assert.ok(/recordIds\.length > MAX_RECORD_IDS/.test(code), '上限を超えたら断っていない');
  assert.ok(/buildDeliveryKeyFormula/.test(code), '名指し formula を使っていない');
  // 無条件の全件取得をしない
  assert.equal(/fetchAll\(/.test(code), false, '全件取得している');
  assert.ok(/MAX_PAGES/.test(code), 'ページ上限が無い');
});

// ── 4. PII を出さない ────────────────────────────────────────
test('【重要】raw customer fields を返さない', () => {
  assert.equal(/fields: r\.fields/.test(code), false, 'fields をそのまま返している');
  assert.equal(/lookupCustomerFields\(/.test(code), false, 'fields 全体を取る関数を使っている');
  assert.ok(/lookupPaidConfirmedAt\(/.test(code), '時刻だけ返す薄いラッパを使っていない');
});

test('【重要】email / 氏名をログへ出さない', () => {
  const logs = code.match(/console\.(log|warn|error)\([^\n]*/g) || [];
  for (const l of logs) {
    for (const bad of ['email', 'Email', '氏名', 'name', 'recordId']) {
      assert.equal(l.includes(bad), false, `ログに ${bad} を出している: ${l}`);
    }
  }
});

test('【重要】レスポンスに宛先・recordId を含めない', () => {
  // ⚠️ 最後の `return json(200, {` が実際のレスポンス（先頭は OPTIONS の空返し）
  const ret = code.slice(code.lastIndexOf('return json(200, {'));
  for (const bad of ['recipientEmail', 'RecipientEmail', 'emails', 'recordIds:', 'fields']) {
    assert.equal(ret.includes(bad), false, `レスポンスに ${bad} を含めている`);
  }
  // 返してよいのは件数と識別子だけ
  assert.ok(/purchases: results\.length/.test(ret));
  assert.ok(/deliveryKey: a\.deliveryKey/.test(ret), '結べた 1 通の識別子を返していない');
});

// ── 5. 読めないものを 0 にしない ─────────────────────────────
test('【重要】読み取り失敗を purchase = 0 にしない', () => {
  // 時刻が取れなければ購入者として数えず、理由を件数で返す
  assert.ok(/purchaseTimeReasons/.test(code), '取れなかった理由を返していない');
  assert.ok(/if \(paid\.paidAtMs === null\)/.test(code), '時刻が無いのに購入として数えている');
  assert.ok(/continue;/.test(code));
  // 配信行が読めないときは null のまま（0 と言わない）
  assert.ok(/deliveries === null \? MEASURE\.UNKNOWN : MEASURE\.ENABLED/.test(code),
    '読めない配信行を計測済みとして扱っている');
  assert.ok(/return null;/.test(code), '取り切れないときに null を返していない');
});

test('【重要】click 由来の direct を捏造しない', () => {
  assert.ok(/clickMeasured: false/.test(code), 'click を測っているかのように渡している');
  assert.ok(/clicked: null/.test(code), 'click を false と書いている');
  assert.ok(/MEASURE\.DISABLED/.test(code), 'click の計測状態を disabled にしていない');
});

test('【重要】PaidAt を checkout 時刻と呼ばない（意味を取り違えない）', () => {
  assert.ok(/入金確認/.test(raw), '有料化確定時刻であることを書いていない');
  assert.equal(/checkout 時刻/.test(raw.replace(/ではありません/g, '')), false, 'checkout と呼んでいる');
});

// ── 6. 購入日時は既存正本を再利用する ────────────────────────
test('【重要】PaidAt を独自 Airtable query で別実装しない', () => {
  assert.ok(/from '\.\.\/\.\.\/src\/lib\/premiumPlus\/purchaseAnchorLookup\.js'/.test(raw),
    '既存の read-only 正本を使っていない');
  // 自前で Customers を叩いていない（配信行だけ名指しで読む）
  assert.equal(/\/Customers/.test(code), false, 'Customers を自前で叩いている');
});

test('【重要】薄いラッパは時刻と理由だけ返す（fields を外へ出さない）', () => {
  const src = strip(read('src/lib/premiumPlus/purchaseAnchorLookup.js'));
  // 宣言順に依存しないよう、関数の開始から**その関数の終わり**までだけを見る
  const start = src.indexOf('export async function lookupPaidConfirmedAt(');
  assert.ok(start >= 0, 'lookupPaidConfirmedAt が無い');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'lookupPaidConfirmedAt の終端が見つからない');
  const fn = src.slice(start, end + 2);
  assert.ok(/paidAtMs/.test(fn) && /reason/.test(fn), '時刻と理由を返していない');
  assert.equal(/return \{ paidAtMs: null, reason: r\.reason \};[\s\S]*fields/.test(fn) && /fields:/.test(fn), false,
    'fields を返している');
  for (const reason of ["'missing'", "'invalid'"]) {
    assert.ok(fn.includes(reason), `${reason} を区別していない`);
  }
});
