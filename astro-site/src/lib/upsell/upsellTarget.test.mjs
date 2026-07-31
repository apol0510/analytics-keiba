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
  const v = view({ ...PREMIUM, ...IMMEDIATE }, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.reason, UPSELL_REASON.ADMIN_PLUS);
  assert.equal(v.plus.showPurchaseCta, true, 'Plus CTA が出ていない');
  assert.equal(v.plus.purchaseEnabled, true);
  assert.equal(v.sanrenpuku.showCta, false, '三連複 CTA が残っている');
  assert.equal(v.sanrenpuku.teaser, 'none', '三連複予告が残っている');
  assertNeverBoth(v, 'plus 指定');
});

test('5-b. plus 指定は PaidAt が無くても Premium 契約が有効なら出せる（即時販売対象）', () => {
  const noPaidAt = { ...PREMIUM, ...IMMEDIATE }; // PaidAt を持たない既存 Premium
  assert.equal(noPaidAt.PaidAt, undefined);
  const v = view(noPaidAt, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.plus.showPurchaseCta, true, 'PaidAt 欠落だけを理由に塞いでいる');
});

test('8. 三連複保有済み + plus 指定 → Plus CTA=true', () => {
  const v = view({ ...SRP_HOLDER, ...IMMEDIATE }, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.plus.showPurchaseCta, true);
  assert.equal(v.sanrenpuku.showCta, false);
});

test('9. Premium Combo + plus 指定 → Plus CTA=true', () => {
  const v = view({ ...COMBO_HOLDER, ...IMMEDIATE }, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.plus.showPurchaseCta, true);
});

test('10. Light + plus 指定 → Plus CTA=false', () => {
  const v = view({ ...LIGHT, ...IMMEDIATE }, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.NONE);
  assert.equal(v.reason, UPSELL_REASON.PLUS_NOT_ELIGIBLE);
  assert.equal(v.plus.showPurchaseCta, false, 'Light に Plus を売っている');
});

test('11. Free + plus 指定 → Plus CTA=false', () => {
  const v = view({ ...FREE, ...IMMEDIATE }, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.NONE);
  assert.equal(v.plus.showPurchaseCta, false, 'Free に Plus を売っている');
});

test('12. blocked + plus 指定 → Plus CTA=false（明示指定より販売禁止が強い）', () => {
  const v = view({ ...PREMIUM, ...BLOCKED }, { target: 'plus', dayNo: 9 });
  assert.equal(v.channel, UPSELL_CHANNEL.NONE);
  assert.equal(v.reason, UPSELL_REASON.PLUS_NOT_ELIGIBLE);
  assert.equal(v.plus.showPurchaseCta, false);
  assert.equal(v.plus.showTeaser, false);
});

test('plus 指定でも受付時間外は購入不可（表示は出す）', () => {
  // 2026-08-03 17:00 JST = intake closed
  const closed = Date.parse('2026-08-03T08:00:00Z');
  const v = view({ ...PREMIUM, ...IMMEDIATE }, { target: 'plus', dayNo: 9, nowMs: closed });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.plus.showPurchaseCta, true);
  assert.equal(v.plus.purchaseEnabled, false, '受付時間外なのに購入できる');
  assert.equal(v.plus.intake, 'closed');
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
    /受付時間外/,
  );
});
