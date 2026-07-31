/**
 * offerCampaignFunction.guard.test.mjs — 割引案内メールの送信経路をソースで固定する
 *   node --test src/lib/promotions/offerCampaignFunction.guard.test.mjs
 *
 * 「実装を後から書き換えても壊せない」性質:
 *   1. 送信順序 — 有効なオファーを持たない相手には送らない（汎用 URL へ倒さない）
 *   2. メール失敗で台帳（PromotionalOffers）を書き換えない
 *   3. 生トークンをキュー・台帳・ログに残さない（送信直前に再生成する）
 *   4. 決済メール v2 のフィールドに触れない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const dispatchSrc = read('../../../netlify/functions/marketing-campaign-dispatch.js');
const adminSrc = read('../../../netlify/functions/admin-marketing.js');
const dispatch = strip(dispatchSrc);
const admin = strip(adminSrc);

test('1. 判定は単一源へ委譲する（Function 内で URL 生成を再実装しない）', () => {
  for (const [name, code] of [['dispatch', dispatch], ['admin', admin]]) {
    assert.ok(code.includes('requiresOfferUrl'), `${name}: requiresOfferUrl を見ていない`);
  }
  assert.ok(dispatch.includes('linkOfferForRecipient'), 'dispatch が結合判定を使っていない');
  // HMAC を Function 内で組み立てない（鍵の扱いを 1 か所に閉じる）
  for (const [name, code] of [['dispatch', dispatch], ['admin', admin]]) {
    assert.equal(/createHmac/.test(code), false, `${name}: トークンを自前で署名している`);
    assert.equal(/signOfferToken\s*\(/.test(code), false, `${name}: 署名関数を直接呼んでいる`);
  }
});

test('2. オファーが結び付かない相手には送らない（fail closed）', () => {
  const i = dispatch.indexOf('needsOffer');
  assert.ok(i > -1, 'オファー分岐が無い');
  // 判定に失敗したら continue（送信キューへ積まない）
  assert.ok(/if \(!link\.ok\) \{[\s\S]{0,400}?continue;/.test(dispatch), '結合失敗時に送信を止めていない');
  // 未解決の差し込みが残ったまま送らない
  assert.ok(dispatch.includes('OFFER_URL_PLACEHOLDER'), '差し込み印を検査していない');
  assert.ok(/offer_url_unresolved/.test(dispatch), '未解決時の記録が無い');
  // 汎用 URL へのフォールバックを持たない
  assert.equal(/\/pricing\//.test(dispatch), false, '汎用 URL へフォールバックしている');
  assert.equal(/\/login\//.test(dispatch), false, '汎用 URL へフォールバックしている');
});

test('3. 送信経路は PromotionalOffers を書き換えない（メール失敗で redeem/revoke しない）', () => {
  for (const [name, code] of [['dispatch', dispatch], ['admin', admin]]) {
    // OFFERS_TABLE への書き込みが無いこと
    const writes = [...code.matchAll(/method:\s*'(PATCH|POST|PUT|DELETE)'/g)];
    for (const m of writes) {
      const around = code.slice(Math.max(0, m.index - 400), m.index + 200);
      assert.equal(around.includes('OFFERS_TABLE'), false,
        `${name}: PromotionalOffers へ書き込んでいる`);
    }
    // 状態遷移の語彙が現れない
    for (const banned of ['buildRedeemFields', 'buildOfferRevokeFields', 'RedeemedAt']) {
      assert.equal(code.includes(banned), false, `${name}: ${banned} に触れている`);
    }
  }
});

test('4. 生トークンをキュー・台帳・ログに残さない', () => {
  // ScheduledEmails / CampaignDeliveries へトークンや URL を保存しない
  assert.equal(/offerUrl.*Metadata|Metadata.*offerUrl/s.test(dispatch), false,
    'トークン付き URL を台帳へ保存している');
  assert.equal(/console\.(log|warn|error)\([^)]*offerUrl/.test(dispatch), false, 'URL をログに出している');
  assert.equal(/console\.(log|warn|error)\([^)]*link\.url/.test(dispatch), false, 'URL をログに出している');
  // 送信直前に組み立てて即使う（変数に貯めて外へ出さない）
  assert.ok(dispatch.includes('offerUrlByEmail'), '受信者ごとの URL 表が無い');
});

test('5. 決済メール v2 のフィールドに触れない', () => {
  for (const [name, code] of [['dispatch', dispatch], ['admin', admin]]) {
    for (const banned of ['PaymentEmailSent', 'PaymentEmailStatus', 'PaymentEmailIdempotencyKey',
      'PaymentConfirmed', 'PaidAt', '有効期限']) {
      assert.equal(code.includes(banned), false, `${name}: ${banned} に触れている`);
    }
  }
});

test('6. admin は台帳と鍵が無いまま計画を作らない（全員 offer_missing にしない）', () => {
  assert.ok(admin.includes('OFFERS_TABLE'), 'admin が台帳を読んでいない');
  assert.ok(admin.includes('offerRecords'), '計画へ台帳を渡していない');
  assert.ok(admin.includes('offerSecret'), '計画へ鍵を渡していない');
  assert.ok(admin.includes('offer_ledger_unavailable') && admin.includes('offer_secret_unavailable'),
    '台帳・鍵の欠落を専用エラーで返していない');
});

test('7. dispatch は台帳を read-only で 1 回だけ読む', () => {
  const m = [...dispatch.matchAll(/fetchAll\(\{[^}]*table:\s*OFFERS_TABLE/g)];
  assert.equal(m.length, 1, `台帳の読み取り回数が想定と違う: ${m.length}`);
  assert.ok(dispatch.includes('anyOfferJob'), '不要なときも台帳を読んでいる');
});
