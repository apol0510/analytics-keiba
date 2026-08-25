/**
 * upsellTarget.test.mjs — 販売導線（どの商品の CTA を見せるか）の判定
 *   node --test src/lib/upsell/upsellTarget.test.mjs
 *
 * 守る性質:
 *   - **1 会員に 2 商品の CTA を同時に出さない**
 *   - 未設定は auto（既存 1,400 件超に migration を要求しない）
 *   - auto の三連複は **既存の段階表示をそのまま維持**（即時 CTA にしない）
 *   - 明示指定でも各商品固有の権限条件は再評価する
 *     （sanrenpuku 指定でも保有済みなら出さない／plus 指定でも資格が無ければ出さない）
 *   - sanrenpuku 指定から Plus へ**フォールバックしない**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UPSELL_TARGET,
  UPSELL_CHANNEL,
  UPSELL_REASON,
  normalizeUpsellTarget,
  readUpsellTarget,
  isUpsellFieldEnabled,
  resolveUpsellDisplay,
  resolveUpsellForCustomer,
  describeUpsellDisplay,
} from './upsellTarget.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { resolvePlusMemberFromFields } from '../premiumPlus/premiumPlusMember.js';
import { resolvePremiumPlusRelease } from '../premiumPlus/premiumPlusRelease.js';
import { planSanrenpukuDisplay } from '../sanrenpuku/sanrenpukuCtaStage.js';
import { buildPreviewSnapshot } from '../premiumPlus/premiumPlusPreview.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DAY = 24 * 60 * 60 * 1000;
/** 2026-08-03 10:00 JST（受付時間内 = intake open） */
const NOW = Date.parse('2026-08-03T01:00:00Z');

// ── Airtable fields の素材 ───────────────────────────────────────
const PREMIUM = {
  Email: 'p@example.com', 'プラン': 'Premium', PlanType: 'Annual',
  Status: 'active', '有効期限': '2099-01-01',
};
const SRP_HOLDER = { ...PREMIUM, 'プラン': 'Premium Sanrenpuku' };
const COMBO_HOLDER = { ...PREMIUM, 'プラン': 'Premium Combo' };
const LIGHT = { Email: 'l@example.com', 'プラン': 'Light', Status: 'active', '有効期限': '2099-01-01' };
const FREE = { Email: 'f@example.com', 'プラン': 'Free', Status: 'active' };

/** 即時販売（eligible + phase4 override） */
const IMMEDIATE = { PremiumPlusEligibility: 'eligible', PremiumPlusReleaseOverride: 'phase4' };
const BLOCKED = { PremiumPlusEligibility: 'blocked', PremiumPlusReleaseOverride: 'phase4' };

/** 実運用と同じ経路で view を作る（判定を再実装しない） */
function view(fields, { target, dayNo, dismissed = false, hasResultSection = true, nowMs = NOW } = {}) {
  // dayNo=1 が初回閲覧日。dayNo 日目 = 初回から (dayNo-1) 日経過
  const sanrenpukuStage = dayNo === undefined ? undefined : planSanrenpukuDisplay({
    planRaw: fields['プラン'],
    dismissed,
    firstSeen: nowMs - (dayNo - 1) * DAY,
    now: nowMs,
    hasResultSection,
  });
  // 管理者指定の値は Airtable の 1 レコードとして渡す（実運用と同じ入口を通す）
  const withTarget = target === undefined ? fields : { ...fields, UpsellTarget: target };
  const full = resolveUpsellForCustomer({ fields: withTarget, nowMs, sanrenpukuStage });
  // 表示判断だけを比較したいので resolver の付随情報は落とす
  const { entitlements, plusRelease, member, ...display } = full;
  return display;
}

/** 2 商品が同時に出ていないことを必ず確認する */
function assertNeverBoth(v, label) {
  const srpVisible = v.sanrenpuku.showCta || v.sanrenpuku.teaser !== 'none' || v.sanrenpuku.showResult;
  const plusVisible = v.plus.showTeaser || v.plus.showPurchaseCta || v.plus.showProductPage;
  assert.equal(srpVisible && plusVisible, false, `${label}: 三連複と Plus を同時表示している`);
}

// ══ 正規化・後方互換 ═══════════════════════════════════════════════

test('15. UpsellTarget 未設定は auto（migration 不要）', () => {
  for (const raw of [undefined, null, '', '  ', 'AUTO', 'unknown-value', 123, {}]) {
    assert.equal(normalizeUpsellTarget(raw), UPSELL_TARGET.AUTO, `${String(raw)} が auto にならない`);
  }
  assert.equal(readUpsellTarget({}), UPSELL_TARGET.AUTO, 'フィールド未作成で auto にならない');
  assert.equal(readUpsellTarget(null), UPSELL_TARGET.AUTO);
  assert.equal(readUpsellTarget({ UpsellTarget: 'PLUS' }), UPSELL_TARGET.PLUS, '大文字を解釈できない');
  // 未設定の会員は auto の会員と完全に同じ結果になる
  const noField = view(PREMIUM, { dayNo: 4 });
  const explicitAuto = view(PREMIUM, { target: 'auto', dayNo: 4 });
  assert.deepEqual(noField, explicitAuto, '未設定と auto で結果が違う');
});

test('書き込み gate は既定 OFF（フィールド未作成の 422 巻き添えを防ぐ）', () => {
  assert.equal(isUpsellFieldEnabled({}), false);
  assert.equal(isUpsellFieldEnabled({ UPSELL_TARGET_FIELD_READY: '0' }), false);
  assert.equal(isUpsellFieldEnabled({ UPSELL_TARGET_FIELD_READY: 'true' }), false);
  assert.equal(isUpsellFieldEnabled({ UPSELL_TARGET_FIELD_READY: '1' }), true);
  assert.equal(isUpsellFieldEnabled(null), false);
});

// ══ auto: 既存の三連複 段階表示を維持する ═══════════════════════════

test('1. active Premium / 未設定(auto) / 三連複未保有 / 1日目 → 三連複予告のみ・Plus なし', () => {
  const v = view(PREMIUM, { dayNo: 1 });
  assert.equal(v.channel, UPSELL_CHANNEL.SANRENPUKU);
  assert.equal(v.reason, UPSELL_REASON.AUTO_SANRENPUKU);
  // 既存仕様: 1 日目は何も出さない（予告は 2 日目から）
  assert.equal(v.sanrenpuku.showCta, false, 'auto で即時 CTA になっている');
  assert.equal(v.plus.showPurchaseCta, false);
  assert.equal(v.plus.showTeaser, false);
  assertNeverBoth(v, '1日目');

  // 2 日目 = 既存の予告
  const d2 = view(PREMIUM, { dayNo: 2 });
  assert.equal(d2.sanrenpuku.teaser, 'day2', '2 日目の予告が既存仕様どおりでない');
  assert.equal(d2.sanrenpuku.showCta, false);
  assert.equal(d2.plus.showTeaser, false);
});

test('2. 同条件 4日目 → 三連複 CTA・Plus なし', () => {
  const v = view(PREMIUM, { dayNo: 4 });
  assert.equal(v.channel, UPSELL_CHANNEL.SANRENPUKU);
  assert.equal(v.sanrenpuku.showCta, true, '4 日目に既存 CTA が出ていない');
  assert.equal(v.plus.showPurchaseCta, false);
  assert.equal(v.plus.showTeaser, false);
  assertNeverBoth(v, '4日目');
});

test('auto: dismiss 済みは既存仕様どおり CTA を出さない', () => {
  const v = view(PREMIUM, { dayNo: 9, dismissed: true });
  assert.equal(v.channel, UPSELL_CHANNEL.SANRENPUKU);
  assert.equal(v.sanrenpuku.showCta, false, 'dismiss が無視されている');
  assert.equal(v.plus.showTeaser, false, 'dismiss を理由に Plus へ乗り換えている');
});

// ══ sanrenpuku 指定 ═══════════════════════════════════════════════

test('3. UpsellTarget=sanrenpuku / 1日目 → 既存予告のまま（即時 CTA にしない）', () => {
  const v = view(PREMIUM, { target: 'sanrenpuku', dayNo: 1 });
  assert.equal(v.channel, UPSELL_CHANNEL.SANRENPUKU);
  assert.equal(v.reason, UPSELL_REASON.ADMIN_SANRENPUKU);
  assert.equal(v.sanrenpuku.showCta, false, '管理者指定で段階表示を飛ばしている');
  assert.equal(v.plus.showTeaser, false);
  assertNeverBoth(v, 'sanrenpuku 1日目');

  const d2 = view(PREMIUM, { target: 'sanrenpuku', dayNo: 2 });
  assert.equal(d2.sanrenpuku.teaser, 'day2');
  assert.equal(d2.sanrenpuku.showCta, false);
});

test('4. UpsellTarget=sanrenpuku / 4日目 → 三連複 CTA・Plus なし', () => {
  const v = view(PREMIUM, { target: 'sanrenpuku', dayNo: 4 });
  assert.equal(v.channel, UPSELL_CHANNEL.SANRENPUKU);
  assert.equal(v.sanrenpuku.showCta, true);
  assert.equal(v.plus.showPurchaseCta, false);
  assertNeverBoth(v, 'sanrenpuku 4日目');
});

test('7. 三連複保有済み + sanrenpuku 指定 → CTA なし・Plus へフォールバックしない', () => {
  for (const fields of [{ ...SRP_HOLDER, ...IMMEDIATE }, { ...COMBO_HOLDER, ...IMMEDIATE }]) {
    const v = view(fields, { target: 'sanrenpuku', dayNo: 9 });
    assert.equal(v.channel, UPSELL_CHANNEL.NONE, '保有済みに何か売ろうとしている');
    assert.equal(v.reason, UPSELL_REASON.SANRENPUKU_OWNED);
    assert.equal(v.sanrenpuku.showCta, false, '再購入 CTA を出している');
    assert.equal(v.plus.showPurchaseCta, false, 'Plus へフォールバックしている');
    assert.equal(v.plus.showTeaser, false);
  }
});

test('sanrenpuku 指定でも購入資格が無ければ出さない（Light / Free / 期限切れ）', () => {
  for (const [label, fields] of [
    ['Light', LIGHT], ['Free', FREE],
    ['期限切れ Premium', { ...PREMIUM, '有効期限': '2026-01-01' }],
  ]) {
    const v = view(fields, { target: 'sanrenpuku', dayNo: 9 });
    assert.equal(v.channel, UPSELL_CHANNEL.NONE, `${label} に三連複 CTA を出している`);
    assert.equal(v.sanrenpuku.showCta, false);
  }
});

// ══ plus 指定 ════════════════════════════════════════════════════

test('5. active Premium + UpsellTarget=plus → 三連複を出さず Plus CTA のみ', () => {
  // ⚠️ eligibility も override も無い素の有効 Premium。明示指定だけで成立する（二重操作なし）
  const v = view(PREMIUM, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.reason, UPSELL_REASON.ADMIN_PLUS);
  assert.equal(v.plus.showPurchaseCta, true, 'Plus CTA が出ていない');
  assert.equal(v.plus.purchaseEnabled, true);
  assert.equal(v.sanrenpuku.showCta, false, '三連複 CTA が残っている');
  assert.equal(v.sanrenpuku.teaser, 'none', '三連複予告が残っている');
  assertNeverBoth(v, 'plus 指定');
});

test('5-b. plus 指定は PaidAt が無くても Premium 契約が有効なら出せる', () => {
  const noPaidAt = { ...PREMIUM }; // PaidAt を持たない既存 Premium
  assert.equal(noPaidAt.PaidAt, undefined);
  const v = view(noPaidAt, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.plus.showPurchaseCta, true, 'PaidAt 欠落だけを理由に塞いでいる');
});

// ══ 明示指定 = 管理者の販売許可（二重操作をなくす）════════════════

test('16. plus 指定 + PremiumPlusEligibility 未設定 → Plus CTA=true（別途 eligible 設定を要求しない）', () => {
  const v = view(PREMIUM, { target: 'plus', dayNo: 9 });
  assert.equal(v.plus.showPurchaseCta, true, 'eligibility 未設定を理由に塞いでいる');
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.reason, UPSELL_REASON.ADMIN_PLUS);
  assertNeverBoth(v, 'plus / eligibility 未設定');
});

test('17. plus 指定 + eligibility=review → Plus CTA=true', () => {
  const v = view({ ...PREMIUM, PremiumPlusEligibility: 'review' }, { target: 'plus', dayNo: 9 });
  assert.equal(v.plus.showPurchaseCta, true, 'review を理由に塞いでいる');
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
});

test('18. plus 指定 + eligibility=blocked → Plus CTA=false（明示指定でも免除しない）', () => {
  const v = view({ ...PREMIUM, PremiumPlusEligibility: 'blocked' }, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.NONE);
  assert.equal(v.reason, UPSELL_REASON.PLUS_NOT_ELIGIBLE);
  assert.equal(v.plus.showPurchaseCta, false, 'blocked に Plus を売っている');
  assert.equal(v.plus.showTeaser, false);
  // blocked + override=phase4 でも通さない
  const withOverride = view(
    { ...PREMIUM, PremiumPlusEligibility: 'blocked', PremiumPlusReleaseOverride: 'phase4' },
    { target: 'plus', dayNo: 9 },
  );
  assert.equal(withOverride.channel, UPSELL_CHANNEL.NONE);
});

// ⚠️ **2026-08-25 MK 仕様変更**: 三連複の保有と Premium Plus の販売資格は**別概念**。
//    会員ランク（Free / Light / 期限切れ Premium）を理由に Plus を塞がない。
//    旧三連複会員を Light 永久無料へ正規化した会員も、管理者が明示指定すれば販売できる。
//    変更前は「plus 指定でも契約が無効なら出さない」だった（下のテストがそれを固定していた）。
//    ⚠️ 開くのは **`UpsellTarget=plus`（1 人ずつの明示指定）だけ**。
//       指定が無い会員（auto）は従来どおり出ない。blocked / 販売停止も従来どおり優先。
test('19. 会員ランクを理由に Plus を塞がない（明示指定のときだけ開く）', () => {
  for (const [label, fields] of [
    ['Light', LIGHT], ['Free', FREE],
    ['期限切れ Premium', { ...PREMIUM, '有効期限': '2026-01-01' }],
  ]) {
    // 明示指定 → 販売対象にできる
    const v = view(fields, { target: 'plus', dayNo: 9 });
    assert.equal(v.channel, UPSELL_CHANNEL.PLUS, `${label} に Plus を売れない`);
    assert.equal(v.plus.showPurchaseCta, true, `${label}: 購入 CTA が出ていない`);
    // 指定が無ければ従来どおり出さない（自動的に配らない）
    const auto = view(fields, { target: 'auto', dayNo: 9 });
    assert.equal(auto.channel, UPSELL_CHANNEL.NONE, `${label}: 指定が無いのに Plus が出ている`);
    assert.equal(auto.plus.showPurchaseCta, false);
  }
  // 三連複の永久権を持つ特殊 tier は現行 entitlement に従う（保有していれば出せる）
  const srp = view({ ...SRP_HOLDER }, { target: 'plus', dayNo: 9 });
  assert.equal(srp.channel, UPSELL_CHANNEL.PLUS);
});

test('20. 明示指定でも 16:30 で対象日が翌日へ切り替わる（購入は可）', () => {
  const closed = Date.parse('2026-08-03T08:00:00Z'); // JST 17:00
  const v = view(PREMIUM, { target: 'plus', dayNo: 9, nowMs: closed });
  assert.equal(v.plus.showPurchaseCta, true);
  // 16:30 以降は翌日分として購入できる（例外リストが空でも販売は続く）
  assert.equal(v.plus.purchaseEnabled, true, '16:30 以降に購入できなくなっている');
  // 16:30 以降・販売可のときは専用状態（CLOSED は「売らない」の意味で残す）
  assert.equal(v.plus.intake, 'next_day_open');
});

test('21. auto の意味は変えない（eligibility 未設定なら従来どおり Plus を出さない）', () => {
  const noElig = view(PREMIUM, { dayNo: 9 });
  assert.equal(noElig.channel, UPSELL_CHANNEL.SANRENPUKU, 'auto で eligibility を免除している');
  assert.equal(noElig.plus.showTeaser, false);
  assert.equal(noElig.plus.showPurchaseCta, false);

  // review も同じく従来どおり
  const review = view({ ...PREMIUM, PremiumPlusEligibility: 'review' }, { dayNo: 9 });
  assert.equal(review.channel, UPSELL_CHANNEL.SANRENPUKU);
  assert.equal(review.plus.showPurchaseCta, false);

  // eligible + override は従来どおり Plus
  const eligible = view({ ...PREMIUM, ...IMMEDIATE }, { dayNo: 9 });
  assert.equal(eligible.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(eligible.plus.showPurchaseCta, true);
});

test('22. 明示指定は Airtable の eligibility 値を書き換えない（判定上の扱いだけ）', () => {
  const fields = { ...PREMIUM, PremiumPlusEligibility: 'review', UpsellTarget: 'plus' };
  const snapshot = JSON.stringify(fields);
  const v = resolveUpsellForCustomer({ fields, nowMs: NOW });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(JSON.stringify(fields), snapshot, '入力レコードを書き換えている');
  // resolver の出力でも eligibility は review のまま（表示のために書き換えない）
  assert.equal(v.plusRelease.eligibility, 'review');
  assert.equal(v.plusRelease.adminSaleDirective, true);
  assert.equal(v.plusRelease.overrideApplied, false, 'override フィールド由来の表示を汚染している');
});

test('8. 三連複保有済み + plus 指定 → Plus CTA=true（eligibility 設定なしでも）', () => {
  const v = view(SRP_HOLDER, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.plus.showPurchaseCta, true);
  assert.equal(v.sanrenpuku.showCta, false);
});

test('9. Premium Combo + plus 指定 → Plus CTA=true（eligibility 設定なしでも）', () => {
  const v = view(COMBO_HOLDER, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.plus.showPurchaseCta, true);
});

test('10. Light + plus 明示指定 → Plus を販売対象にできる（2026-08-25 仕様変更）', () => {
  const v = view({ ...LIGHT, ...IMMEDIATE }, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS, 'Light に Plus を売れない');
  assert.equal(v.plus.showPurchaseCta, true);
});

test('11. Free + plus 明示指定 → Plus を販売対象にできる（2026-08-25 仕様変更）', () => {
  const v = view({ ...FREE, ...IMMEDIATE }, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS, 'Free に Plus を売れない');
  assert.equal(v.plus.showPurchaseCta, true);
});

test('12. blocked + plus 指定 → Plus CTA=false（明示指定より販売禁止が強い）', () => {
  const v = view({ ...PREMIUM, ...BLOCKED }, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.NONE);
  assert.equal(v.reason, UPSELL_REASON.PLUS_NOT_ELIGIBLE);
  assert.equal(v.plus.showPurchaseCta, false);
  assert.equal(v.plus.showTeaser, false);
});

test('plus 指定でも 16:30 以降は翌日分として購入できる', () => {
  // 2026-08-03 17:00 JST = intake closed
  const closed = Date.parse('2026-08-03T08:00:00Z');
  const v = view({ ...PREMIUM, ...IMMEDIATE }, { target: 'plus', dayNo: 9, nowMs: closed });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.plus.showPurchaseCta, true);
  // 16:30 以降は翌日分として購入できる（例外リストが空でも販売は続く）
  assert.equal(v.plus.purchaseEnabled, true, '16:30 以降に購入できなくなっている');
  // 16:30 以降・販売可のときは専用状態（CLOSED は「売らない」の意味で残す）
  assert.equal(v.plus.intake, 'next_day_open');
});

test('未ログイン / 退会 / 停止は plus 指定でも何も出さない（fail closed）', () => {
  for (const [label, fields] of [
    ['退会', { ...PREMIUM, ...IMMEDIATE, WithdrawalRequested: true }],
    ['停止', { ...PREMIUM, ...IMMEDIATE, Status: 'suspended' }],
    ['強制ログアウト', { ...PREMIUM, ...IMMEDIATE, ForceLogout: true }],
  ]) {
    const v = view(fields, { target: 'plus', dayNo: 9 });
    assert.equal(v.channel, UPSELL_CHANNEL.NONE, `${label} に販売導線が出ている`);
    assert.equal(v.reason, UPSELL_REASON.NOT_LOGGED_IN);
  }
});

// ══ none 指定 ════════════════════════════════════════════════════

test('6. active Premium + UpsellTarget=none → 三連複も Plus も出さない', () => {
  const v = view({ ...PREMIUM, ...IMMEDIATE }, { target: 'none', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.NONE);
  assert.equal(v.reason, UPSELL_REASON.ADMIN_NONE);
  assert.equal(v.sanrenpuku.showCta, false);
  assert.equal(v.sanrenpuku.teaser, 'none');
  assert.equal(v.sanrenpuku.showResult, false);
  assert.equal(v.plus.showTeaser, false);
  assert.equal(v.plus.showProductPage, false);
  assert.equal(v.plus.showPurchaseCta, false);
});

// ══ auto と即時販売の競合 ════════════════════════════════════════

test('13. 即時販売対象 + auto → Plus を優先し、三連複と同時表示しない', () => {
  // 三連複未保有・購入資格ありの Premium が、同時に Plus の即時販売対象でもあるケース
  const v = view({ ...PREMIUM, ...IMMEDIATE }, { dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.reason, UPSELL_REASON.AUTO_PLUS_SALE);
  assert.equal(v.plus.showPurchaseCta, true);
  assert.equal(v.sanrenpuku.showCta, false, '三連複 CTA と同時に出ている');
  assert.equal(v.sanrenpuku.teaser, 'none');
  assertNeverBoth(v, 'auto + 即時販売');
});

test('14. 即時販売対象 + plus 指定 → Plus CTA=true', () => {
  const v = view({ ...SRP_HOLDER, ...IMMEDIATE }, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.plus.showPurchaseCta, true);
  assert.equal(v.plus.purchaseEnabled, true);
});

test('auto: Plus が予告(phase2/3)止まりなら、三連複を売れる相手には三連複を優先する', () => {
  // phase 2/3 相当 = eligible だが override 無し・anchor から日が浅い
  const teaserOnly = {
    ...PREMIUM, PremiumPlusEligibility: 'eligible',
    PaidAt: new Date(NOW - 40 * DAY).toISOString(),
    PremiumPlusEligibleAt: new Date(NOW - 4 * DAY).toISOString(),
  };
  const v = view(teaserOnly, { dayNo: 4 });
  assert.equal(v.channel, UPSELL_CHANNEL.SANRENPUKU, '予告止まりの Plus が三連複を押しのけている');
  assert.equal(v.sanrenpuku.showCta, true);
  assert.equal(v.plus.showTeaser, false, 'Plus 予告と三連複 CTA が同時に出ている');
  assertNeverBoth(v, 'auto teaser 競合');
});

test('auto: 三連複を売れない相手（保有済み）には Plus の予告を出す', () => {
  const teaserOnly = {
    ...SRP_HOLDER, PremiumPlusEligibility: 'eligible',
    PremiumPlusEligibleAt: new Date(NOW - 4 * DAY).toISOString(),
  };
  const v = view(teaserOnly, { dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.reason, UPSELL_REASON.AUTO_PLUS_TEASER);
  assert.equal(v.plus.showTeaser, true);
  assert.equal(v.plus.showPurchaseCta, false, '予告 phase なのに購入 CTA が出ている');
  assert.equal(v.sanrenpuku.showCta, false);
});

test('auto: どちらも売れない相手には何も出さない', () => {
  for (const [label, fields] of [['Light', LIGHT], ['Free', FREE]]) {
    const v = view(fields, { dayNo: 9 });
    assert.equal(v.channel, UPSELL_CHANNEL.NONE, `${label} に販売導線が出ている`);
  }
});

// ══ サーバー側（段階表示を知らない）でも channel は決まる ═══════════

test('sanrenpukuStage 省略（サーバー側）でも channel は決まり、段階はクライアントに委ねる', () => {
  const v = view(PREMIUM, {}); // dayNo 未指定 → stage を渡さない
  assert.equal(v.channel, UPSELL_CHANNEL.SANRENPUKU);
  assert.equal(v.sanrenpuku.allowed, true);
  assert.equal(v.sanrenpuku.stage, 'unknown', 'サーバー側で段階を推測している');
  assert.equal(v.sanrenpuku.showCta, false, 'サーバー側で CTA を確定させている');
});

test('describeUpsellDisplay は設定値ではなく実表示を返す', () => {
  assert.equal(describeUpsellDisplay(view({ ...PREMIUM, ...IMMEDIATE }, { target: 'plus', dayNo: 9 })), 'Plus CTA');
  assert.equal(describeUpsellDisplay(view(PREMIUM, { dayNo: 4 })), '三連複CTA');
  assert.match(describeUpsellDisplay(view(PREMIUM, { dayNo: 2 })), /三連複予告/);
  assert.equal(describeUpsellDisplay(view({ ...PREMIUM, ...IMMEDIATE }, { target: 'none', dayNo: 9 })), '表示なし');
  const closed = Date.parse('2026-08-03T08:00:00Z');
  assert.match(
    describeUpsellDisplay(view({ ...PREMIUM, ...IMMEDIATE }, { target: 'plus', dayNo: 9, nowMs: closed })),
    /翌日分受付中/,
  );
});

// ══ 管理プレビューが顧客側と同じ判定になっていること ══════════════════
//
// 一覧・顧客ページ・プレビューで UpsellTarget の判定がズレると、
// 「管理画面では出ないのに顧客には出る（またはその逆）」が起きる。
// プレビューは buildPreviewSnapshot 経由でも **同じ resolver** を通ることを固定する。

test('23. preview が UpsellTarget を反映する（plus + eligibility 未設定 / review → Plus CTA）', () => {
  for (const [label, extra] of [['未設定', {}], ['review', { PremiumPlusEligibility: 'review' }]]) {
    const fields = { ...PREMIUM, ...extra, UpsellTarget: 'plus' };
    const p = buildPreviewSnapshot({ fields, nowMs: NOW });
    assert.equal(p.ok, true);
    assert.equal(p.preview.upsellChannel, UPSELL_CHANNEL.PLUS, `${label}: preview の channel が違う`);
    assert.equal(p.preview.route, 'premium_admin', `${label}: route が premium_admin でない`);
    assert.equal(p.preview.showProductPage, true, `${label}: 商品ページが出ない`);
    assert.equal(p.preview.showPurchaseCta, true, `${label}: 購入 CTA が出ない`);
    assert.equal(p.preview.adminSaleDirective, true);
    assert.equal(p.preview.productPageStatus, 200);
    // eligibility の値は書き換えない（表示のためにデータを触らない）
    assert.equal(p.preview.eligibility, 'review');
  }
});

test('24. preview: plus + blocked → Plus 表示不可', () => {
  const fields = { ...PREMIUM, PremiumPlusEligibility: 'blocked', UpsellTarget: 'plus' };
  const p = buildPreviewSnapshot({ fields, nowMs: NOW });
  assert.equal(p.preview.upsellChannel, UPSELL_CHANNEL.NONE);
  assert.equal(p.preview.showPurchaseCta, false);
  assert.equal(p.preview.showProductPage, false);
  assert.equal(p.preview.productPageStatus, 404);
});

test('25. preview: Free / Light / 期限切れ Premium + plus → 販売対象として表示できる', () => {
  for (const [label, base] of [['Light', LIGHT], ['Free', FREE],
    ['期限切れ Premium', { ...PREMIUM, '有効期限': '2026-01-01' }]]) {
    const p = buildPreviewSnapshot({ fields: { ...base, UpsellTarget: 'plus' }, nowMs: NOW });
    assert.equal(p.preview.upsellChannel, UPSELL_CHANNEL.PLUS, `${label}: Plus を出せない`);
    assert.equal(p.preview.showPurchaseCta, true, `${label}: 購入 CTA が出ていない`);
    // 指定が無ければ従来どおり出さない
    const auto = buildPreviewSnapshot({ fields: { ...base }, nowMs: NOW });
    assert.equal(auto.preview.upsellChannel, UPSELL_CHANNEL.NONE, `${label}: 指定無しで Plus が出ている`);
  }
});

test('26. preview: sanrenpuku / none 指定では Plus を出さない', () => {
  const srp = buildPreviewSnapshot({ fields: { ...PREMIUM, UpsellTarget: 'sanrenpuku' }, nowMs: NOW });
  assert.equal(srp.preview.upsellChannel, UPSELL_CHANNEL.SANRENPUKU);
  assert.equal(srp.preview.showTeaser, false, 'Plus 予告が出ている');
  assert.equal(srp.preview.showPurchaseCta, false);
  assert.equal(srp.preview.sanrenpukuAllowed, true);

  const none = buildPreviewSnapshot({ fields: { ...PREMIUM, ...IMMEDIATE, UpsellTarget: 'none' }, nowMs: NOW });
  assert.equal(none.preview.upsellChannel, UPSELL_CHANNEL.NONE);
  assert.equal(none.preview.showPurchaseCta, false);
  assert.equal(none.preview.sanrenpukuAllowed, false);
});

test('27. preview と顧客側 resolver の結論が一致する（auto / plus / sanrenpuku / none × 資格）', () => {
  const cases = [];
  for (const target of [undefined, 'auto', 'plus', 'sanrenpuku', 'none']) {
    for (const [label, extra] of [
      ['eligibility 未設定', {}],
      ['review', { PremiumPlusEligibility: 'review' }],
      ['eligible', { PremiumPlusEligibility: 'eligible' }],
      ['blocked', { PremiumPlusEligibility: 'blocked' }],
      ['即時販売', IMMEDIATE],
    ]) {
      for (const [tier, base] of [['Premium', PREMIUM], ['三連複保有', SRP_HOLDER],
        ['Light', LIGHT], ['Free', FREE]]) {
        cases.push([`${tier}/${label}/${target ?? '未設定'}`,
          target === undefined ? { ...base, ...extra } : { ...base, ...extra, UpsellTarget: target }]);
      }
    }
  }
  assert.ok(cases.length >= 80, 'ケース数が少なすぎる');
  for (const [label, fields] of cases) {
    const customer = resolveUpsellForCustomer({ fields, nowMs: NOW });
    const p = buildPreviewSnapshot({ fields, nowMs: NOW });
    assert.equal(p.ok, true, `${label}: preview が組み立てられない`);
    assert.equal(p.preview.upsellChannel, customer.channel, `${label}: channel が不一致`);
    assert.equal(p.preview.showPurchaseCta, customer.plus.showPurchaseCta, `${label}: showPurchaseCta が不一致`);
    assert.equal(p.preview.showProductPage, customer.plus.showProductPage, `${label}: showProductPage が不一致`);
    assert.equal(p.preview.showTeaser, customer.plus.showTeaser, `${label}: showTeaser が不一致`);
    assert.equal(p.preview.purchaseEnabled, customer.plus.purchaseEnabled, `${label}: purchaseEnabled が不一致`);
    assert.equal(p.preview.upsellDisplay, describeUpsellDisplay(customer), `${label}: 実表示ラベルが不一致`);
  }
});

test('28. preview は Airtable へ書き込む形を一切持たない（read-only）', () => {
  const src = readFileSync(fileURLToPath(new URL('../premiumPlus/premiumPlusPreview.js', import.meta.url)), 'utf8');
  assert.equal(/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/i.test(src), false, '書き込みメソッドがある');
  assert.equal(/api\.airtable\.com/.test(src), false, 'Airtable を直接呼んでいる');
  // フラグ導出を再実装していない（単一源を共有している）
  assert.ok(/resolvePlusAdminFlags/.test(src), 'フラグ導出の単一源を使っていない');
  assert.equal(/adminPlusAuthorized:\s*(true|target)/.test(src), false, 'フラグ導出を再実装している');
});
