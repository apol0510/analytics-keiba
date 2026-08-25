/**
 * sanrenpukuLifetimeAccess.test.mjs — 三連複 買い切り購入者の**恒久的な閲覧権**
 *   node --test src/lib/auth/sanrenpukuLifetimeAccess.test.mjs
 *
 * ## 守る要件（MK 確認 2026-08-25）
 *
 *   **三連複を買い切りで購入した方は、その閲覧権を恒久的に保持する。
 *     Premium（馬単）の期限が切れたあとは、三連複ページ*だけ*閲覧できる。**
 *
 * ## なぜ層をまたいで 1 本のテストにするか
 *
 * この要件は 3 つの層が全部そろって初めて成立し、**どれか 1 つが欠けると
 * 「ログインはできるのにページが開かない」**になる。層ごとのテストは既にあるが、
 * つながっていることを確かめるテストが無かった。
 *
 *   1. `resolveMembership` … 期限切れでも **有料セッションを発行してよい**と判定する
 *      ⚠️ ここが free に落ちると **セッション自体が発行されない**
 *         （`sessionPayload` が free を拒否する）ので、以降の層は一切効かない
 *   2. `issuePaidSessionCookie` … その判定を署名 Cookie にする
 *   3. `gatePaidPage` … Cookie で本人を確定し、**権利は Airtable の正本**で判定する
 *
 * ## 買い切りの目印は `LifetimeSanrenpuku`
 *
 * 三連複の申込を承認すると `buildConfirmationFields` が `LifetimeSanrenpuku=true` を書き、
 * **`有効期限` は触らない**（`payments/bankPaymentFlow.js`）。
 * したがって「買い切りかどうか」はこのフラグが正本で、契約の期限とは独立している。
 *
 * ⚠️ フラグの無い旧プラン名（`Premium Sanrenpuku` / `Premium Combo`）だけの会員は、
 *    買い切りだったのか期間契約だったのかを**データから判別できない**。
 *    よって期限切れでは通さない（fail closed）。通すべき会員が居るなら
 *    **フラグを立てる**のが正しい直し方で、判定式を緩めるのではない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveMembership, MEMBER_TYPE, MEMBER_REASON } from './memberResolution.js';
import { issuePaidSessionCookie } from './sessionIssuance.js';
import { gatePaidPage } from './paidPageGate.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { buildConfirmationFields } from '../payments/bankPaymentFlow.js';

const SECRET = 'test-only-fixed-hmac-secret-DO-NOT-USE-IN-PROD-0123456789';
const NOW = Date.parse('2026-08-25T03:00:00.000Z');
const env = { SESSION_SIGNING_SECRET: SECRET };

/** 三連複を買い切りで購入し、そのあと Premium（馬単）の期限が切れた会員 */
const EXPIRED_WITH_LIFETIME = {
  'プラン': 'Premium',
  PlanType: 'Annual',
  '有効期限': '2026-03-31',       // 過去
  LifetimeSanrenpuku: true,
  Status: 'active',
};

/** 同じ状況だが三連複を買っていない会員 */
const EXPIRED_WITHOUT_LIFETIME = { ...EXPIRED_WITH_LIFETIME, LifetimeSanrenpuku: false };

/** ログイン → 有料セッション Cookie を持つ Request を作る（実経路と同じ手順） */
async function loginAs(fields) {
  const membership = resolveMembership({ fields, recordId: 'recTEST', now: NOW });
  if (membership.memberType !== MEMBER_TYPE.PAID) return { membership, request: null };
  const issued = await issuePaidSessionCookie({
    membership, secret: SECRET, now: NOW, subtle: globalThis.crypto.subtle,
  });
  assert.ok(issued.ok, `session 発行に失敗: ${issued.reason}`);
  return {
    membership,
    request: new Request('https://example.test/premium-sanrenpuku/', {
      headers: { cookie: issued.cookie.split(';')[0] },
    }),
  };
}

const gate = (request, requiredPlan, fields) => gatePaidPage({
  request, requiredPlan, env, now: NOW, lookup: async () => fields,
});

// ── 1. ログインできること（ここが free に落ちると以降が全部効かない）──────
test('期限切れでも、買い切り購入者には有料セッションが発行される', async () => {
  const { membership } = await loginAs(EXPIRED_WITH_LIFETIME);
  assert.equal(membership.memberType, MEMBER_TYPE.PAID, '無料扱いになるとセッションが出ない');
  assert.equal(membership.normalizedPlan, 'premium-sanrenpuku');
  assert.equal(membership.reason, MEMBER_REASON.LIFETIME_SANRENPUKU);
  assert.equal(membership.lifetimeSanrenpuku, true);
});

// ── 2. 三連複ページ**だけ**開く ──────────────────────────────────
test('【要件】Premium 期限切れ後は、三連複ページだけ閲覧できる', async () => {
  const { request } = await loginAs(EXPIRED_WITH_LIFETIME);
  assert.ok(request, '前提: ログインできている');

  const sanrenpuku = await gate(request, 'Premium Sanrenpuku', EXPIRED_WITH_LIFETIME);
  assert.equal(sanrenpuku.ok, true, `三連複が開けない: ${sanrenpuku.reason}`);
  assert.equal(sanrenpuku.response, null);

  // 馬単（Premium）は閲覧できない
  const premium = await gate(request, 'premium', EXPIRED_WITH_LIFETIME);
  assert.equal(premium.ok, false, '期限切れの馬単まで開いてしまっている');
  assert.equal(premium.reason, 'entitlement_denied');

  // Light も閲覧できない（三連複だけ、の「だけ」を固定する）
  const light = await gate(request, 'standard', EXPIRED_WITH_LIFETIME);
  assert.equal(light.ok, false, 'Light まで開いてしまっている');
});

test('【要件】期限がどれだけ過ぎても三連複は開く（恒久的に保持する）', async () => {
  const longExpired = { ...EXPIRED_WITH_LIFETIME, '有効期限': '2020-01-01' };
  const { request, membership } = await loginAs(longExpired);
  assert.equal(membership.memberType, MEMBER_TYPE.PAID);
  const g = await gate(request, 'Premium Sanrenpuku', longExpired);
  assert.equal(g.ok, true, `${g.reason}`);
});

test('Status=expired（文字列での期限切れ表現）でも三連複は開く', async () => {
  const fields = { ...EXPIRED_WITH_LIFETIME, Status: 'expired' };
  const { request, membership } = await loginAs(fields);
  assert.equal(membership.memberType, MEMBER_TYPE.PAID, 'Status=expired で締め出している');
  const g = await gate(request, 'Premium Sanrenpuku', fields);
  assert.equal(g.ok, true, `${g.reason}`);
  const p = await gate(request, 'premium', fields);
  assert.equal(p.ok, false, '馬単まで開いている');
});

test('プラン欄が旧表記（Premium Sanrenpuku / Premium Combo）でも、フラグがあれば開く', async () => {
  for (const plan of ['Premium Sanrenpuku', 'Premium Combo']) {
    const fields = { ...EXPIRED_WITH_LIFETIME, 'プラン': plan };
    const { request, membership } = await loginAs(fields);
    assert.equal(membership.memberType, MEMBER_TYPE.PAID, `${plan} で締め出している`);
    const g = await gate(request, 'Premium Sanrenpuku', fields);
    assert.equal(g.ok, true, `${plan}: ${g.reason}`);
  }
});

// ── 3. 権利を持たない人には開かない（fail closed）────────────────────
test('三連複を買っていない期限切れ会員は、三連複も馬単も開かない', async () => {
  const { membership } = await loginAs(EXPIRED_WITHOUT_LIFETIME);
  // 有料セッションは出ない（＝無料会員としてのログインになる）
  assert.notEqual(membership.memberType, MEMBER_TYPE.PAID);
  const e = resolveEntitlements(fromAirtableFields(EXPIRED_WITHOUT_LIFETIME), NOW);
  assert.equal(e.canViewSanrenpuku, false);
  assert.equal(e.canViewPremium, false);
});

test('退会・強制ログアウトは買い切りより優先される（安全側）', async () => {
  for (const stop of [{ WithdrawalRequested: true }, { ForceLogout: true }]) {
    const fields = { ...EXPIRED_WITH_LIFETIME, ...stop };
    const { membership } = await loginAs(fields);
    assert.notEqual(membership.memberType, MEMBER_TYPE.PAID, `${JSON.stringify(stop)} で有料セッションが出ている`);
    const e = resolveEntitlements(fromAirtableFields(fields), NOW);
    assert.equal(e.canViewSanrenpuku, false);
  }
});

// ── 4. 購入 → 恒久化 のつながり ────────────────────────────────────
test('三連複の入金確認は、買い切りの目印だけを書き 有効期限に触らない', () => {
  const r = buildConfirmationFields({
    requestedPlan: 'Premium Sanrenpuku', requestedPlanType: 'Lifetime',
    confirmedAt: new Date(NOW),
  });
  assert.ok(r, '承認内容を作れていない');
  assert.equal(r.fields['LifetimeSanrenpuku'], true, '買い切りの目印を書いていない');
  assert.equal(r.expiration, null, '有効期限を書き換えている（買い切りが期限に縛られてしまう）');
  assert.equal('有効期限' in r.fields, false);
  assert.equal('プラン' in r.fields, false, '会員ランクまで書き換えている');
});

test('購入直後の状態から、そのまま期限切れになっても三連複は残る', async () => {
  // 承認が書いた内容を、Premium 期限切れの既存レコードへ載せた形
  const confirmed = buildConfirmationFields({
    requestedPlan: 'Premium Sanrenpuku', requestedPlanType: 'Lifetime', confirmedAt: new Date(NOW),
  });
  const fields = { 'プラン': 'Premium', PlanType: 'Annual', '有効期限': '2026-03-31', Status: 'active',
    ...confirmed.fields };
  const { request, membership } = await loginAs(fields);
  assert.equal(membership.memberType, MEMBER_TYPE.PAID);
  const g = await gate(request, 'Premium Sanrenpuku', fields);
  assert.equal(g.ok, true, `${g.reason}`);
});

// ── 5. 旧三連複会員への「付与」方式（2026-08-25 MK 確定）──────────────
//
// 確定仕様: 旧プラン名で期限切れの会員には、購入履歴の追加調査を条件にせず
// `LifetimeSanrenpuku` を**付与**して恒久閲覧権を渡す。
// **判定式は緩めない**（旧プラン名だけで自動的に買い切り扱いにしない）。
// 正本: docs/spec.md §三連複 買い切りの閲覧権は恒久 / docs/decisions.md 2026-08-25

/** 付与の対象になる会員の形（旧プラン名・フラグ無し・期限切れ）*/
const LEGACY_EXPIRED = {
  'プラン': 'Premium Sanrenpuku',
  PlanType: '',
  '有効期限': '2026-01-18',
  Status: '',
};

test('【判定式を緩めない】旧プラン名だけ + 期限切れ は三連複を開かない', async () => {
  for (const plan of ['Premium Sanrenpuku', 'Premium Combo']) {
    const fields = { ...LEGACY_EXPIRED, 'プラン': plan };
    const e = resolveEntitlements(fromAirtableFields(fields), NOW);
    assert.equal(e.canViewSanrenpuku, false,
      `${plan}: プラン名だけで恒久権を配っている（期間契約が終わった会員にも配ってしまう）`);
    const { membership } = await loginAs(fields);
    assert.notEqual(membership.memberType, MEMBER_TYPE.PAID, `${plan}: 有料セッションが出ている`);
  }
});

test('【付与方式】LifetimeSanrenpuku を立てるだけで三連複が開く（それ以外は何も変えない）', async () => {
  // 付与前
  const before = resolveEntitlements(fromAirtableFields(LEGACY_EXPIRED), NOW);
  assert.equal(before.canViewSanrenpuku, false);

  // 付与（**この 1 フィールドだけ**を変える）
  const granted = { ...LEGACY_EXPIRED, LifetimeSanrenpuku: true };
  assert.deepEqual(
    Object.keys(granted).filter((k) => granted[k] !== LEGACY_EXPIRED[k]),
    ['LifetimeSanrenpuku'],
    '付与で他のフィールドまで変えている',
  );

  const after = resolveEntitlements(fromAirtableFields(granted), NOW);
  assert.equal(after.canViewSanrenpuku, true, '付与しても三連複が開かない');

  // 馬単・Light・購入資格は**復活させない**
  assert.equal(after.canViewPremium, false, '馬単まで復活している');
  assert.equal(after.canViewLight, false, 'Light まで復活している');
  assert.equal(after.paidPremiumActive, false, '有料 Premium 扱いになっている');
  assert.equal(after.canPurchaseSanrenpuku, false);
  assert.equal(after.premiumExpired, true, '期限切れである事実が消えている');

  // ページの入口でも同じ（三連複だけ開く）
  const { request } = await loginAs(granted);
  assert.ok(request, '付与後もログインできない');
  assert.equal((await gate(request, 'Premium Sanrenpuku', granted)).ok, true);
  assert.equal((await gate(request, 'premium', granted)).ok, false);
  assert.equal((await gate(request, 'standard', granted)).ok, false);
});

test('【付与の取り消し】フラグを外せば元の状態へ戻る（rollback が 1 フィールドで済む）', () => {
  const granted = { ...LEGACY_EXPIRED, LifetimeSanrenpuku: true };
  const rolledBack = { ...granted, LifetimeSanrenpuku: false };
  assert.equal(resolveEntitlements(fromAirtableFields(rolledBack), NOW).canViewSanrenpuku, false);
  assert.equal(resolveEntitlements(fromAirtableFields(LEGACY_EXPIRED), NOW).canViewSanrenpuku, false);
});

test('【副作用の確認】付与しても Premium Plus は開かない（販売資格は別フィールド）', async () => {
  const { resolvePlusMemberFromFields } = await import('../premiumPlus/premiumPlusMember.js');
  const granted = { ...LEGACY_EXPIRED, LifetimeSanrenpuku: true };
  const m = resolvePlusMemberFromFields(granted, { nowMs: NOW });
  assert.equal(m.hasSanrenpuku, true, '前提: 三連複は保有している');
  assert.equal(m.premiumActive, false, '有料 Premium 扱いになっている');
  // 販売資格は Airtable の明示フィールド。未設定は review = 販売不可（fail closed）
  assert.equal(m.eligibility, 'review', '付与だけで Premium Plus の販売資格が付いている');
});
