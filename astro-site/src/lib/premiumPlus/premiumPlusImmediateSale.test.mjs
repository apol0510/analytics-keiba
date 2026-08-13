/**
 * premiumPlusImmediateSale.test.mjs — 「即時販売」= **今すぐ商品ページで買える**を固定する
 *   node --test src/lib/premiumPlus/premiumPlusImmediateSale.test.mjs
 *
 * ── なぜこのテストが要るか ────────────────────────────────────
 * 「販売可（eligible）にした＝すぐ買える」と誤解され、段階公開の待機日数
 * （PHASE 1→4）が残ったまま「反応が無い」と見える事故が起きた。
 * ここでは **顧客に見えるのと同じ経路**（`buildPreviewSnapshot` → 顧客側 resolver）で、
 *   - 「今すぐ販売可」＝ `PremiumPlusReleaseOverride = 'phase4'` を確定した瞬間に
 *     **その会員だけ** PHASE 4 相当になり、**`/premium-plus/` を開けて購入できる**
 *
 * ⚠️ **恒久的な回帰条件はこの連鎖**:
 *     「今すぐ販売可」確定 → `override='phase4'` → `phase=4`
 *       → `showProductPage=true` → `purchaseEnabled=true` → 本人が `/premium-plus/` で購入できる
 *
 * ⚠️ **三連複ページの teaser / CTA は既存の段階公開設計を維持する。**
 *    即時販売を理由に「新しい強い CTA を即時表示する」ことは**要件に含めない**。
 *    `showPurchaseCta` は公開判定の値として確認するが、**完成条件にはしない**。
 *   - route は**その会員本来のもの**を保つ
 *   - override が無ければ**従来の段階公開のまま**
 *   - 保留 / 販売対象外は override があっても**売らせない**
 * を固定する。**新しいフィールドは増やさない**（既存 override が正本）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildPreviewSnapshot } from './premiumPlusPreview.js';
import { buildAdminActionFields, PP_ADMIN_ACTION } from './premiumPlusEligibility.js';
import {
  PP_RELEASE_OVERRIDE, PP_ROUTE, PP_PHASE, PP_ELIGIBILITY_FIELDS,
} from './premiumPlusRelease.js';

const NOW = Date.parse('2026-08-07T01:00:00.000Z');   // JST 10:00（受付 open の時間帯）
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

/** 三連複会員（買い切り）。`SanrenpukuPaidAt` は本番でも空のことがある */
const sanrenpuku = (over = {}) => ({
  'プラン': 'Premium Sanrenpuku', PlanType: 'Lifetime', Status: 'active',
  '有効期限': '2099-12-31',
  PaidAt: daysAgo(23),
  PremiumPlusEligibility: 'eligible',
  PremiumPlusEligibleAt: daysAgo(8),          // → 通常なら PHASE 3
  ...over,
});

/** Premium 会員（加入 5 日 = 30 日ルール未達） */
const premium = (over = {}) => ({
  'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
  '有効期限': '2099-12-31',
  PaidAt: daysAgo(5),
  PremiumPlusEligibility: 'eligible',
  PremiumPlusEligibleAt: daysAgo(5),
  ...over,
});

const view = (fields, nowMs = NOW) => {
  const r = buildPreviewSnapshot({ fields, nowMs });
  assert.equal(r.ok, true, `preview 失敗: ${r.reason}`);
  return r.preview;
};

/** 管理画面の「今すぐ販売可」を押したときに書かれる値を、実装から作る */
const immediateFields = (current) => {
  const built = buildAdminActionFields({
    action: PP_ADMIN_ACTION.IMMEDIATE,
    current: current.PremiumPlusEligibility,
    currentOverride: current.PremiumPlusReleaseOverride,
    reason: 'テスト', actor: 'test', now: NOW, overrideFieldEnabled: true,
  });
  assert.ok(built, '即時販売の更新内容を作れない');
  return { ...current, ...built.fields };
};

// ══ 1. 即時販売を確定したら、その場で買える ═══════════════════

test('【恒久回帰条件】PHASE 3 の三連複会員 → 今すぐ販売可 → /premium-plus/ で購入できる', () => {
  const before = view(sanrenpuku());
  assert.equal(before.phase, PP_PHASE.PREVIEW, '前提: 待機中（PHASE 3）');
  assert.equal(before.purchaseEnabled, false, '前提: まだ買えない');

  // 管理操作 → 保存値
  const saved = immediateFields(sanrenpuku());
  assert.equal(saved[PP_ELIGIBILITY_FIELDS.OVERRIDE], PP_RELEASE_OVERRIDE.PHASE4);

  // 保存値 → 公開判定 → 商品ページの可否 → 購入可否
  const after = view(saved);
  assert.equal(after.phase, PP_PHASE.SALE, 'phase=4');
  assert.equal(after.showProductPage, true, '/premium-plus/ を開ける');
  assert.equal(after.purchaseEnabled, true, '購入できる');
  // ⚠️ route は本人本来のものを保つ
  assert.equal(after.route, PP_ROUTE.SANRENPUKU);
  // 公開判定値としては true になる（ただし三連複ページの強い CTA を保証するものではない）
  assert.equal(after.showPurchaseCta, true);
});

test('Premium 会員（加入 5 日 = 30 日未達）でも 即時販売で買える', () => {
  const before = view(premium());
  assert.equal(before.purchaseEnabled, false, '前提: まだ売らない');

  const after = view(immediateFields(premium()));
  assert.equal(after.phase, PP_PHASE.SALE);
  assert.equal(after.showProductPage, true);
  assert.equal(after.purchaseEnabled, true);
  // 管理者が明示指定したときの route（三連複ではないので premium 側）
  assert.equal(after.route, PP_ROUTE.PREMIUM_ADMIN);
});

test('即時販売は EligibleAt / PaidAt の待機より優先される', () => {
  // 販売許可を「今日」にしても、通常なら PHASE 1 のまま
  const staged = view(sanrenpuku({ PremiumPlusEligibleAt: daysAgo(0) }));
  assert.equal(staged.phase, PP_PHASE.LOCKED);
  assert.equal(staged.showPurchaseCta, false);

  // 同じ日でも即時販売なら PHASE 4（＝商品ページで買える）
  const now = view(immediateFields(sanrenpuku({ PremiumPlusEligibleAt: daysAgo(0) })));
  assert.equal(now.phase, PP_PHASE.SALE);
  assert.equal(now.showProductPage, true);
  assert.equal(now.purchaseEnabled, true);
});

test('三連複ページの販売導線は即時販売で変わらない（段階公開設計を維持）', () => {
  // ⚠️ 即時販売が保証するのは商品ページの可否と購入可否。
  //    三連複ページに「新しい強い CTA を即時表示する」ことは要件に含めない。
  const PAGE = readFileSync(fileURLToPath(
    new URL('../../pages/premium-sanrenpuku.astro', import.meta.url)), 'utf8');
  // 予告枠（段階公開に従う）は残す
  assert.match(PAGE, /<PremiumPlusStageTeaser \/>/);
  // 強い CTA 本体は有効化しない（存在秘匿の設計を勝手に変えない）
  assert.equal(/^\s*import PremiumPlusCta/m.test(PAGE), false,
    '即時販売を理由に強い CTA を有効化してはいけない');
});

// ══ 2. 既存フィールドだけを使う ═══════════════════════════════

test('書くのは既存の override フィールドだけ（新しい列を増やさない）', () => {
  const built = buildAdminActionFields({
    action: PP_ADMIN_ACTION.IMMEDIATE, current: 'eligible', currentOverride: null,
    reason: 'r', actor: 'a', now: NOW, overrideFieldEnabled: true,
  });
  assert.equal(built.fields[PP_ELIGIBILITY_FIELDS.OVERRIDE], PP_RELEASE_OVERRIDE.PHASE4);
  assert.equal(built.override, PP_RELEASE_OVERRIDE.PHASE4);
  // 「即時販売」専用の新規フィールドを作っていない
  for (const k of Object.keys(built.fields)) {
    assert.ok(/^PremiumPlus/.test(k), `Plus 以外の列を書こうとしている: ${k}`);
    assert.equal(/immediate|即時/i.test(k), false, `同義の新規フィールドを増やしている: ${k}`);
  }
});

// ══ 3. override が無ければ従来どおり ═════════════════════════

test('override なし → 段階公開のまま（PHASE 1〜3 を飛ばさない）', () => {
  for (const [d, expected] of [[0, PP_PHASE.LOCKED], [3, PP_PHASE.TEASER], [6, PP_PHASE.PREVIEW], [10, PP_PHASE.SALE]]) {
    const p = view(sanrenpuku({ PremiumPlusEligibleAt: daysAgo(d) }));
    assert.equal(p.phase, expected, `${d} 日経過の PHASE`);
    assert.equal(p.showPurchaseCta, expected === PP_PHASE.SALE, `${d} 日経過の CTA`);
  }
});

// ══ 4. 売ってはいけない状態は override でも売らない ═══════════

test('保留 / 販売対象外は override が残っていても売らせない', () => {
  for (const st of ['review', 'blocked']) {
    const p = view(sanrenpuku({
      PremiumPlusEligibility: st, PremiumPlusReleaseOverride: PP_RELEASE_OVERRIDE.PHASE4,
    }));
    assert.equal(p.phase, PP_PHASE.LOCKED, `${st}: PHASE`);
    assert.equal(p.showProductPage, false, `${st}: ページ`);
    assert.equal(p.showPurchaseCta, false, `${st}: CTA`);
    assert.equal(p.purchaseEnabled, false, `${st}: 購入`);
  }
});

test('保留 / 販売対象外へ落とすときは override を必ず解除する', () => {
  for (const action of [PP_ADMIN_ACTION.REVIEW, PP_ADMIN_ACTION.BLOCKED]) {
    const built = buildAdminActionFields({
      action, current: 'eligible', currentOverride: PP_RELEASE_OVERRIDE.PHASE4,
      reason: 'r', actor: 'a', now: NOW, overrideFieldEnabled: true,
    });
    assert.equal(built.fields[PP_ELIGIBILITY_FIELDS.OVERRIDE], PP_RELEASE_OVERRIDE.NONE,
      `${action}: override が残ると再 eligible で即時販売が復活する`);
  }
});

test('契約が無効なら override があっても売らない', () => {
  const p = view(sanrenpuku({
    Status: 'inactive', '有効期限': '2020-01-01',
    PremiumPlusReleaseOverride: PP_RELEASE_OVERRIDE.PHASE4,
  }));
  assert.equal(p.showPurchaseCta, false);
  assert.equal(p.purchaseEnabled, false);
});

// ══ 5. 受付時間帯は変えない ═══════════════════════════════════

test('即時販売でも 16:30 で対象日が翌日へ切り替わる（購入は可）', () => {
  const closed = Date.parse('2026-08-07T08:00:00.000Z');   // JST 17:00
  const p = view(immediateFields(sanrenpuku()), closed);
  assert.equal(p.phase, PP_PHASE.SALE, 'PHASE は 4 のまま');
  assert.equal(p.showProductPage, true, '商品ページは開ける');
  // 2026-08-13〜: 16:30 以降は「翌日分」として購入できる（対象日が切り替わるだけ）
  assert.equal(p.purchaseEnabled, true, '16:30 以降は翌日分として購入できるはず');
});

// ══ 6. 冪等・他顧客への波及なし ═══════════════════════════════

test('同じ操作を繰り返しても結果が変わらない（冪等）', () => {
  const once = immediateFields(sanrenpuku());
  const twice = immediateFields(once);
  assert.equal(twice[PP_ELIGIBILITY_FIELDS.OVERRIDE], PP_RELEASE_OVERRIDE.PHASE4);
  const a = view(once); const b = view(twice);
  for (const k of ['phase', 'route', 'showProductPage', 'purchaseEnabled']) {
    assert.equal(b[k], a[k], `${k} が 2 回目で変わった`);
  }
  // 2 回目は override を PATCH に含めない（無駄な書き込みをしない）
  const second = buildAdminActionFields({
    action: PP_ADMIN_ACTION.IMMEDIATE, current: 'eligible',
    currentOverride: PP_RELEASE_OVERRIDE.PHASE4,
    reason: 'r', actor: 'a', now: NOW, overrideFieldEnabled: true,
  });
  assert.equal(second.overrideChanged, false, '同じ値をもう一度書こうとしている');
});

test('他の顧客には影響しない（判定は 1 レコードだけを見る）', () => {
  const target = immediateFields(sanrenpuku());
  const other = sanrenpuku();            // 何も操作していない別会員
  const otherStillStaged = view(other);
  assert.equal(otherStillStaged.phase, PP_PHASE.PREVIEW);
  assert.equal(otherStillStaged.purchaseEnabled, false, '別会員まで売れる状態になった');
  assert.equal(view(target).purchaseEnabled, true);
});

// ══ 7. schema 未準備なら fail closed ═════════════════════════

test('override フィールドが無ければ「今すぐ販売可」は成立しない', () => {
  const built = buildAdminActionFields({
    action: PP_ADMIN_ACTION.IMMEDIATE, current: 'eligible', currentOverride: null,
    reason: 'r', actor: 'a', now: NOW, overrideFieldEnabled: false,
  });
  assert.equal(built, null, 'フィールド未作成なのに即時販売を作ってしまう');
});

// ══ 8. 画面の文言が動作と一致している ════════════════════════

test('管理画面の文言が「即時に購入できる」ことを明示している', () => {
  const PAGE = readFileSync(fileURLToPath(
    new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url)), 'utf8');

  // 即時販売の説明に「CTA」「購入」が入っている
  assert.match(PAGE, /今すぐ販売可（CTA表示・購入可）/);
  assert.match(PAGE, /即座に PHASE 4（販売中）にします/);
  // ⚠️ 「どこに何が出るか」を操作者に見せる。
  //    三連複ページの導線は段階公開設計のままで、この操作では変わらないと明示する。
  assert.match(PAGE, /価格と申込ボタンが出て購入できます/);
  assert.match(PAGE, /三連複ページ（\/premium-sanrenpuku\/）の販売導線は段階公開の設計どおり/);
  assert.match(PAGE, /この操作では変わりません/);
  // 段階公開の側は「今日は買えない」と明示する
  assert.match(PAGE, /段階公開で販売可（CTAは待機後）/);
  assert.match(PAGE, /今日は買えません/);
  // 一覧フィルタも同じ意味に揃える
  assert.match(PAGE, /即時販売（CTA表示・購入可）/);
  // 確認ダイアログは従来どおり残す
  assert.match(PAGE, /この会員は即時PHASE 4となり、価格と購入CTAが表示されます。/);
});
