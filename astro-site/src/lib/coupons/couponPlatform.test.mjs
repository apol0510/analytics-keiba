/**
 * couponPlatform.test.mjs — **商品によらない**クーポン基盤
 *
 * 一番大事な検査: **2 商品目を足すときに Premium Plus のコードをコピーしなくてよい**こと。
 * 合成の「2 商品目」binding を作り、Premium Plus を 1 行も import せずに
 * 付与 / 再発行 / 訂正 / 予約取消 の全規則が効くことを確かめる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const P = await import('./couponPlatform.js');

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const ACT = { actor: 'MK', reason: 'テストの理由' };

/** 合成の 2 商品目（**Premium Plus とは無関係**。保存先は別の 3 列という想定） */
const OTHER_PRODUCT_FIELDS = Object.freeze({
  CLAIMED_AT: 'DemoCouponClaimedAt', COUPON_ID: 'DemoCouponId', SOURCE: 'DemoCouponSource',
});
const ALLOWED = new Set(Object.values(OTHER_PRODUCT_FIELDS));
const demoBinding = {
  couponId: 'demo-product-coupon',
  version: 2,
  productKey: 'premium_monthly',
  readHolding: (f) => {
    const at = (f || {})[OTHER_PRODUCT_FIELDS.CLAIMED_AT] || '';
    return {
      claimed: !!at, claimedAtIso: at, claimedAtMs: at ? Date.parse(at) : null,
      couponId: (f || {})[OTHER_PRODUCT_FIELDS.COUPON_ID] || '',
      source: (f || {})[OTHER_PRODUCT_FIELDS.SOURCE] || '',
    };
  },
  isStorageEnabled: (env) => !!env && env.DEMO_COUPON_READY === '1',
  buildClaimFields: (i) => guard({
    [OTHER_PRODUCT_FIELDS.CLAIMED_AT]: i.atIso,
    [OTHER_PRODUCT_FIELDS.COUPON_ID]: 'demo-product-coupon@v2',
    [OTHER_PRODUCT_FIELDS.SOURCE]: P.encodeCouponAudit(i),
  }),
  buildClearFields: (i) => guard({
    [OTHER_PRODUCT_FIELDS.CLAIMED_AT]: null,
    [OTHER_PRODUCT_FIELDS.SOURCE]: P.encodeCouponAudit(i),
  }),
};
function guard(fields) {
  return Object.keys(fields).every((k) => ALLOWED.has(k)) ? fields : null;
}

const ENV = { DEMO_COUPON_READY: '1' };
const LEDGER_OK = { available: true, hasIssued: false, hasRedeemed: false, issuedRecordId: null, count: 0 };
const plan = (over = {}) => P.resolveCouponOperationPlan({
  holding: demoBinding.readHolding({}), reservations: LEDGER_OK, binding: demoBinding,
  env: ENV, nowMs: NOW, ...ACT, ...over,
});

// ── 2 商品目が Premium Plus 抜きで動く ───────────────────────
test('共通層は特定商品のモジュールを import していない', () => {
  // 文章としての「Premium Plus」は説明なので許す。**import 文だけ**を見る
  const imports = (src) => (src.match(/^\s*import[\s\S]*?from\s+'[^']+';/gm) || []).join('\n');
  for (const f of ['./couponPlatform.js', './couponOperationHistory.js']) {
    const got = imports(read(f));
    assert.doesNotMatch(got, /premiumPlus/i, `${f} が特定商品へ依存している: ${got}`);
  }
  // カタログだけは定義の値を各商品の単一源から取るので import してよい
  const cat = imports(read('./couponCatalog.js'));
  assert.match(cat, /premiumPlusReopenCoupon\.js/, 'カタログが Premium Plus の定義を参照していない');
});

test('2 商品目: binding を 1 つ書くだけで 付与 → 訂正 → 再発行 が通る', () => {
  const O = P.COUPON_OPERATION;
  // 付与（履歴なし）
  const granted = plan({ operation: O.GRANT });
  assert.equal(granted.ok, true);
  assert.equal(granted.target, 'holding');
  assert.equal(granted.fields[OTHER_PRODUCT_FIELDS.CLAIMED_AT], new Date(NOW).toISOString());
  // Premium Plus の列は 1 つも出てこない
  for (const k of Object.keys(granted.fields)) assert.doesNotMatch(k, /PremiumPlus/);

  // 訂正
  const afterGrant = { ...granted.fields };
  const corrected = plan({ operation: O.CORRECT, holding: demoBinding.readHolding(afterGrant) });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.fields[OTHER_PRODUCT_FIELDS.CLAIMED_AT], null);
  const afterCorrect = { ...afterGrant, ...corrected.fields };
  // 履歴が残っている
  assert.equal(P.describeCouponHistory(demoBinding.readHolding(afterCorrect)).had, true);

  // 再発行
  const reissued = plan({ operation: O.REISSUE, holding: demoBinding.readHolding(afterCorrect) });
  assert.equal(reissued.ok, true);
  assert.equal(P.parseCouponAudit(reissued.fields[OTHER_PRODUCT_FIELDS.SOURCE]).kind, 'admin-reissue');
});

test('2 商品目でも 付与と再発行は排他', () => {
  const O = P.COUPON_OPERATION;
  const R = P.COUPON_REJECT;
  assert.equal(plan({ operation: O.REISSUE }).code, R.NO_HISTORY);
  const granted = plan({ operation: O.GRANT }).fields;
  const corrected = plan({ operation: O.CORRECT, holding: demoBinding.readHolding(granted) }).fields;
  const after = { ...granted, ...corrected };
  assert.equal(plan({ operation: O.GRANT, holding: demoBinding.readHolding(after) }).code, R.HISTORY_EXISTS);
  assert.equal(plan({ operation: O.REISSUE, holding: demoBinding.readHolding(after) }).ok, true);
});

test('2 商品目でも fail closed（台帳不明 / 使用済み / 予約中 / 保存先未有効）', () => {
  const O = P.COUPON_OPERATION;
  const R = P.COUPON_REJECT;
  const held = demoBinding.readHolding(plan({ operation: O.GRANT }).fields);
  const cases = [
    [{ reservations: { available: false } }, R.LEDGER_UNAVAILABLE],
    [{ reservations: { ...LEDGER_OK, hasRedeemed: true }, holding: held }, R.ALREADY_REDEEMED],
    [{ reservations: { ...LEDGER_OK, hasIssued: true, issuedRecordId: 'r1', count: 1 } }, R.RESERVATION_ACTIVE],
    [{ env: {} }, R.STORAGE_DISABLED],
  ];
  for (const [over, code] of cases) {
    assert.equal(plan({ operation: O.GRANT, ...over }).code, code, JSON.stringify(over));
  }
});

test('2 商品目でも 操作者・理由が無ければ実行しない', () => {
  const R = P.COUPON_REJECT;
  assert.equal(plan({ operation: 'grant', actor: '' }).code, R.MISSING_ACTOR);
  assert.equal(plan({ operation: 'grant', reason: '' }).code, R.MISSING_REASON);
  assert.equal(plan({ operation: 'destroy' }).code, R.UNKNOWN_ACTION);
});

test('binding の許可外フィールドは組み立てさせない（fail closed）', () => {
  const bad = { ...demoBinding, buildClaimFields: () => null };
  const out = P.resolveCouponOperationPlan({
    operation: 'grant', holding: { claimed: false }, reservations: LEDGER_OK,
    binding: bad, env: ENV, nowMs: NOW, ...ACT,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, P.COUPON_REJECT.FIELD_ALLOW_LIST);
});

// ── 予約取消は保有状態に触らない（商品によらない）─────────────
test('予約取消は保有状態を書かない', () => {
  const out = plan({
    operation: P.COUPON_OPERATION.REVOKE_RESERVATION,
    reservations: { available: true, hasIssued: true, hasRedeemed: false, issuedRecordId: 'recR1', count: 1 },
  });
  assert.equal(out.ok, true);
  assert.equal(out.target, 'reservation');
  assert.equal(out.reservationRecordId, 'recR1');
  assert.equal(out.fields, undefined);
  assert.equal(out.customerFieldsUnchanged, true);
});

// ── 画面のボタン活性も共通 ───────────────────────────────────
test('ボタン活性は商品によらず同じ規則', () => {
  const view = (fields, rv = LEDGER_OK) => Object.fromEntries(P.describeCouponOperationAvailability({
    holding: demoBinding.readHolding(fields), reservations: rv, binding: demoBinding, env: ENV,
  }).actions.map((a) => [a.action, a.enabled]));
  const granted = plan({ operation: 'grant' }).fields;
  assert.deepEqual([view({}).grant, view({}).reissue], [true, false]);
  assert.deepEqual([view(granted).grant, view(granted).reissue], [false, false]);
  // 台帳不明なら全部落ちる
  const unknown = P.describeCouponOperationAvailability({
    holding: { claimed: true }, reservations: { available: false }, binding: demoBinding, env: ENV,
  });
  assert.ok(unknown.actions.every((a) => a.enabled === false));
  assert.equal(unknown.redeemed, null, '確認できないのに「使用済みでない」と断定している');
});

// ── 監査の書式は全商品で同じ ─────────────────────────────────
test('監査の書式は商品に依存しない', () => {
  const enc = P.encodeCouponAudit({
    kind: 'admin-grant', actor: 'MK', atIso: '2026-08-20T00:00:00.000Z', reason: 'a|b=c',
  });
  const got = P.parseCouponAudit(enc);
  assert.equal(got.byAdmin, true);
  assert.equal(got.reason, 'a|b=c');
  assert.equal(P.parseCouponAudit('coupon-page').byAdmin, false);
});
