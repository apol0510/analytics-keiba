/**
 * offerRevokeFunction.guard.test.mjs — 割引オファー取り消し経路の安全条件をソースで固定する
 *   node --test src/lib/promotions/offerRevokeFunction.guard.test.mjs
 *
 * 「実装を後から書き換えても壊せない」性質:
 *   1. revoke ロジックを Function 内で再実装しない（単一源 planOfferRevoke / buildOfferRevokeFields）
 *   2. offer 取り消しで Customers を書かない・読まない
 *   3. 認可（x-admin-secret）が無ければ 403
 *   4. dry-run の fingerprint が無ければ書かない（TOCTOU / 409 fail closed）
 *   5. メールを送らない
 *   6. grant revoke（Customers の特典カラム）経路が消えていない＝回帰していない
 *   7. まとめ取り消しの経路を作らない（1 件ずつ）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { OFFER_FORBIDDEN_FIELDS } from './promotionalOffer.js';

const fnPath = fileURLToPath(new URL('../../../netlify/functions/admin-comeback-grants.js', import.meta.url));
const src = readFileSync(fnPath, 'utf8');
/** コメントを除いた実コード（説明文で guard が誤検知しないようにする） */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** handleOfferRevoke 本体だけを切り出す（他ハンドラのコードで判定が緩まないように） */
function offerRevokeBody() {
  const start = code.indexOf('async function handleOfferRevoke');
  assert.ok(start > -1, 'handleOfferRevoke が存在しない');
  const rest = code.slice(start);
  const end = rest.indexOf('\nasync function ', 1);
  return end > -1 ? rest.slice(0, end) : rest;
}

test('1. 3 つの action が生えている（dry-run / 実行 / 一覧）', () => {
  for (const a of ['offerList', 'offerRevokeDryRun', 'offerRevoke']) {
    assert.ok(code.includes(`action === '${a}'`), `${a} が dispatch されていない`);
  }
  // grant 側の action も残っている（回帰していない）
  for (const a of ['revokeDryRun', 'revoke', 'dryRun', 'apply', 'reconcile']) {
    assert.ok(code.includes(`action === '${a}'`), `既存の ${a} が消えている`);
  }
});

test('2. revoke ロジックを再実装しない（単一源へ委譲する）', () => {
  const body = offerRevokeBody();
  assert.ok(body.includes('planOfferRevoke('), 'planOfferRevoke を使っていない');
  // Status/Notes を Function 内で組み立てていない
  assert.equal(/Status:\s*['"]revoked['"]/.test(body), false, 'Status を直書きしている');
  assert.equal(/Notes:\s*[`'"]/.test(body), false, 'Notes を直書きしている');
  // 書き込むのは plan の戻り値だけ
  assert.ok(/fields:\s*plan\.fields/.test(body), 'plan.fields 以外を書こうとしている');
  // 判定の本体は純粋モジュール側にある
  const planSrc = readFileSync(fileURLToPath(new URL('./offerRevokePlan.js', import.meta.url)), 'utf8');
  assert.ok(planSrc.includes('buildOfferRevokeFields'), '純粋モジュールが既存の単一源を使っていない');
});

test('3. offer 取り消しで Customers を読み書きしない', () => {
  const body = offerRevokeBody();
  assert.equal(body.includes('CUSTOMERS_TABLE'), false, 'Customers テーブルに触れている');
  assert.equal(body.includes('loadCustomers'), false, 'Customers を読んでいる');
  for (const banned of OFFER_FORBIDDEN_FIELDS) {
    assert.equal(body.includes(banned), false, `${banned} がコードに現れる`);
  }
  for (const banned of ['プラン', '有効期限', 'PaidAt', 'PaymentConfirmed', 'PaymentEmailSent',
    'RequestedPlan', 'RequestedAmount', 'LifetimeSanrenpuku', 'UpsellTarget',
    'PremiumPlusEligibility', 'LightGrant', 'PremiumGrant']) {
    assert.equal(body.includes(banned), false, `${banned} がコードに現れる`);
  }
  // PATCH 先は台帳だけ
  const patches = [...body.matchAll(/\$\{BASE\}\/\$\{encodeURIComponent\((\w+)\)\}/g)].map((m) => m[1]);
  assert.ok(patches.length > 0, '書き込み経路が消えている（テストの前提が壊れた）');
  for (const t of patches) assert.equal(t, 'OFFERS_TABLE', `想定外のテーブル: ${t}`);
  assert.ok(body.includes('customersWritten: 0'));
});

test('4. 認可が無ければ 403（既存の gate を弱めていない）', () => {
  assert.ok(code.includes("provided !== SECRET"), 'secret 照合が消えている');
  assert.ok(/return json\(403, \{ error: 'Forbidden' \}\)/.test(code), '403 を返していない');
  assert.ok(code.includes('PREMIUM_PLUS_ADMIN_SECRET'), 'secret の出所が消えている');
});

test('5. dry-run の fingerprint が無ければ 1 バイトも書かない', () => {
  const body = offerRevokeBody();
  assert.ok(body.includes('offerFingerprint'), 'fingerprint を受け取っていない');
  assert.ok(/if \(!token\) return json\(400/.test(body), 'fingerprint 未指定を弾いていない');
  assert.ok(/token !== plan\.fingerprint/.test(body), 'fingerprint を照合していない');
  assert.ok(/json\(409, \{/.test(body), '不一致で 409 を返していない');
  // 書き込みは fingerprint 照合より後
  assert.ok(body.indexOf('token !== plan.fingerprint') < body.indexOf("method: 'PATCH'"),
    'fingerprint 照合の前に書き込んでいる');
  // dry-run では書かない
  assert.ok(body.indexOf('if (!live)') < body.indexOf("method: 'PATCH'"), 'dry-run が書き込み側にある');
  assert.ok(body.includes("sideEffects: 'none'"));
});

test('6. 状態不正（redeemed / expired / revoked / 不存在）を握りつぶさない', () => {
  const body = offerRevokeBody();
  assert.ok(/if \(!plan\.ok\)/.test(body), '判定結果を無視している');
  assert.ok(/json\(record \? 409 : 404/.test(body), '不存在と状態不正を返し分けていない');
  assert.ok(body.includes('OFFER_REVOKE_SKIP_LABEL'), '理由をラベル化して返していない');
});

test('7. メールを送らない', () => {
  const body = offerRevokeBody();
  for (const banned of ['sendgrid', 'mail/send', 'nodemailer', 'ScheduledEmails',
    'CampaignDeliveries', 'EmailBlacklist']) {
    assert.equal(body.toLowerCase().includes(banned.toLowerCase()), false, `${banned} に触れている`);
  }
  assert.ok(body.includes('emailSent: false'));
});

test('8. まとめ取り消しの経路を作らない（1 件ずつ）', () => {
  const body = offerRevokeBody();
  assert.ok(body.includes('offerRecordIds'), '複数指定を明示的に拒否していない');
  assert.ok(/records: \[\{ id: offerRecordId/.test(body), '単一レコード PATCH になっていない');
  assert.equal(/chunkTargets/.test(body), false, 'バッチ経路を使っている');
});

test('9. 台帳 gate（COMEBACK_OFFER_TABLE_READY）を通る', () => {
  const body = offerRevokeBody();
  assert.ok(body.includes('isOfferTableEnabled'), 'gate を通っていない');
  assert.ok(body.includes('503'), 'gate 未設定で 503 を返していない');
});

test('10. grant revoke（Customers の特典カラム）経路が回帰していない', () => {
  assert.ok(code.includes('async function handleRevoke'), 'grant revoke が消えている');
  assert.ok(code.includes('buildRevokePlan'), 'grant revoke の単一源が消えている');
  // grant revoke は Customers を書き続ける（offer 側と混ざっていない）
  const start = code.indexOf('async function handleRevoke');
  const rest = code.slice(start);
  const end = rest.indexOf('\nasync function ', 1);
  const grantBody = end > -1 ? rest.slice(0, end) : rest;
  assert.ok(grantBody.includes('CUSTOMERS_TABLE'), 'grant revoke が Customers を書かなくなっている');
  assert.equal(grantBody.includes('OFFERS_TABLE'), false, 'grant revoke が台帳に触れている');
});
