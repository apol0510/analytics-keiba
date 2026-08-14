/**
 * plusCtaSurfaces.test.mjs — 三連複会員に **三連単（Premium Plus）CTA が実際に出る**ことを
 * サーフェスごとに固定する
 *   node --test src/lib/premiumPlus/plusCtaSurfaces.test.mjs
 *
 * ## なぜ必要か
 *
 * 「CTA が出ているか」は憶測で答えてはいけない。出る／出ないは
 * **3 つのサーフェスがそれぞれ別のゲート**を通した結果で決まる:
 *
 *   A. 三連複ページの予告枠  … `/api/premium-plus-stage.json`（channel + showTeaser + 文言 + phase）
 *   B. dashboard のボタン    … `/api/upsell.json`（channel だけ）
 *   C. 商品ページ            … `/premium-plus/`（channel + showProductPage、価格は showPurchaseCta）
 *
 * どれか 1 つが 404 でも「CTA が出ている」とは言えない。
 * ここでは **本番に実在する三連複会員の項目構成**（2026-08-13 実測・PII は含めない）を
 * fixture にして、各ゲートの結果を固定する。
 *
 * ## 時刻に依存する部分を混ぜない
 *
 * 申込ボタンが押せるかは**受付時間帯（12:30〜16:30 JST）**で変わる。
 * 「時間外だから押せない」を「CTA が出ていない」と混同しないよう、
 * 表示（price/CTA の有無）と操作可否（purchaseEnabled）を別々に固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveUpsellForCustomer, UPSELL_CHANNEL } from '../upsell/upsellTarget.js';
import { PP_PHASE, PP_INTAKE, teaserCopyForRoute, intakeCopy } from './premiumPlusRelease.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { PREMIUM_PLUS_CANDIDATE_PLANS } from '../auth/index.js';

/**
 * 本番に実在する三連複会員の項目構成（2026-08-13 実測）。
 * **旧プラン名（`Premium Sanrenpuku`）+ `PlanType=Lifetime` + `LifetimeSanrenpuku=false`** という、
 * 現行形式（`Premium` + `LifetimeSanrenpuku=true`）とは違う持ち方をしている点が要。
 * アドレス・氏名・recordId は含めない。
 */
const SANRENPUKU_MEMBER = Object.freeze({
  'プラン': 'Premium Sanrenpuku',
  PlanType: 'Lifetime',
  Status: 'active',
  '有効期限': '2099-12-31',
  LifetimeSanrenpuku: false,
  PaidAt: '2026-07-15T05:34:04.097Z',
  PremiumPlusEligibility: 'eligible',
  PremiumPlusEligibleAt: '2026-07-29T16:11:51.236Z',
  PremiumPlusReleaseOverride: 'phase4',
});

/** 受付時間内（14:00 JST）と時間外（17:46 JST）*/
const AT_OPEN = Date.parse('2026-08-13T05:00:00Z');
const AT_CLOSED = Date.parse('2026-08-13T08:46:00Z');

const view = (fields, now) => resolveUpsellForCustomer({ fields, nowMs: now });

/** A: 三連複ページの予告枠。`/api/premium-plus-stage.json` と同じ順序で判定する */
function stageApi(fields, now) {
  const up = view(fields, now);
  if (up.channel !== UPSELL_CHANNEL.PLUS) return { status: 404, why: 'channel' };
  const rel = up.plusRelease;
  if (!rel.showTeaser) return { status: 404, why: 'showTeaser' };
  const teaser = teaserCopyForRoute(rel.route, rel.phase);
  if (!teaser) return { status: 404, why: 'copy' };
  return {
    status: 200,
    teaser,
    productHref: rel.phase >= PP_PHASE.PREVIEW ? '/premium-plus/' : null,
  };
}

/** その予告枠が**リンクとして描画されるか**（PremiumPlusStageTeaser の条件と同じ） */
const stageShowsLink = (s) => s.status === 200
  && !!s.productHref && String(s.teaser.linkLabel || '').trim() !== '';

// ── 前提: この会員は Plus の入口を通れる ───────────────────────
test('三連複会員はログインでき、Plus 候補プランに入る', () => {
  const ent = resolveEntitlements(fromAirtableFields(SANRENPUKU_MEMBER), AT_CLOSED);
  assert.equal(ent.canLogin, true);
  assert.equal(ent.canViewSanrenpuku, true, '三連複を閲覧できない');
  assert.ok(PREMIUM_PLUS_CANDIDATE_PLANS.includes(ent.effectiveTier),
    `effectiveTier=${ent.effectiveTier} が Plus 候補プランに無い`);
});

// ── 本題: 3 サーフェスすべてで CTA が出る ─────────────────────
test('【重要】A. 三連複ページの予告枠に商品ページへの CTA リンクが出る', () => {
  const s = stageApi(SANRENPUKU_MEMBER, AT_CLOSED);
  assert.equal(s.status, 200, `予告枠が 404（理由: ${s.why}）`);
  assert.equal(s.productHref, '/premium-plus/');
  assert.ok(String(s.teaser.linkLabel || '').trim(), 'リンクラベルが空だとリンクごと出ない');
  assert.equal(stageShowsLink(s), true, 'CTA リンクが描画されない');
});

test('【重要】B. dashboard の Plus ボタンが出る（channel=plus）', () => {
  assert.equal(view(SANRENPUKU_MEMBER, AT_CLOSED).channel, UPSELL_CHANNEL.PLUS);
});

test('【重要】C. 商品ページが開き、価格が表示される', () => {
  const up = view(SANRENPUKU_MEMBER, AT_CLOSED);
  assert.equal(up.plus.showProductPage, true, '商品ページが 404');
  assert.equal(up.plus.showPurchaseCta, true, '価格・申込 CTA が非表示');
});

// ── 三連複 CTA とは同時に出さない ─────────────────────────────
test('三連複の再購入 CTA は出さない（2 商品を並べない）', () => {
  assert.equal(view(SANRENPUKU_MEMBER, AT_CLOSED).sanrenpuku.allowed, false);
});

// ── 時間帯: 「押せない」を「出ていない」と混同しない ───────────
test('【重要】受付時間内は申込ボタンを操作できる', () => {
  const up = view(SANRENPUKU_MEMBER, AT_OPEN);
  assert.equal(up.plus.showPurchaseCta, true);
  assert.equal(up.plus.purchaseEnabled, true, '受付時間内なのに操作不可');
});

test('【重要】16:30 を過ぎても CTA は消えず、翌日分として購入できる', () => {
  // AT_CLOSED は 17:46 JST。
  // ⚠️ 2026-08-14〜の仕様変更: 16:30 は「売らない」ではなく
  //    **「翌日分へ切り替わる」**。旧仕様（purchaseEnabled=false）で固定すると、
  //    翌日分販売そのものを止める方向に効くので戻さないこと。
  //    「売らない」は `closed`（例外日が連続する異常時のみ）だけが表す。
  const up = view(SANRENPUKU_MEMBER, AT_CLOSED);
  assert.equal(up.plus.showProductPage, true, '時間外に商品ページごと消えている');
  assert.equal(up.plus.showPurchaseCta, true, '時間外に価格ごと消えている');
  assert.equal(up.plusRelease.intake, PP_INTAKE.NEXT_DAY_OPEN,
    '16:30 以降が翌日分受付になっていない');
  assert.equal(up.plus.purchaseEnabled, true, '翌日分の購入まで止めている');
  assert.equal(stageShowsLink(stageApi(SANRENPUKU_MEMBER, AT_CLOSED)), true,
    '時間外に予告枠の CTA まで消えている');
  const ic = intakeCopy(up.plusRelease.intake);
  assert.match(ic.status, /翌日分/, '受付状態が翌日分と読めない');
  assert.match(ic.note, /本日分の受付は終了/, '本日分が締まったことを伝えていない');
});

// ── 「今すぐ販売可」は既に冗長 ────────────────────────────────
test('override を外しても PHASE 4 のまま（販売許可日から十分日数が経過）', () => {
  const noOverride = { ...SANRENPUKU_MEMBER, PremiumPlusReleaseOverride: '' };
  const up = view(noOverride, AT_CLOSED);
  assert.equal(up.plusRelease.phase, PP_PHASE.SALE, 'override を外すと販売が止まる');
  assert.equal(up.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(up.plus.showProductPage, true);
});

// ── 逆側: 出てはいけない相手には出ない ────────────────────────
test('無料会員には Plus の予告も商品ページも出ない（存在秘匿）', () => {
  const free = { 'プラン': 'Free' };
  assert.equal(stageApi(free, AT_CLOSED).status, 404);
  assert.notEqual(view(free, AT_CLOSED).channel, UPSELL_CHANNEL.PLUS);
  assert.equal(view(free, AT_CLOSED).plus.showProductPage, false);
});

test('販売対象外（blocked）にすると全サーフェスで消える', () => {
  const blocked = { ...SANRENPUKU_MEMBER, PremiumPlusEligibility: 'blocked' };
  assert.equal(stageApi(blocked, AT_CLOSED).status, 404);
  assert.equal(view(blocked, AT_CLOSED).plus.showProductPage, false);
});

test('販売導線を none に設定すると全サーフェスで消える', () => {
  const none = { ...SANRENPUKU_MEMBER, UpsellTarget: 'none' };
  assert.equal(stageApi(none, AT_CLOSED).status, 404);
  assert.notEqual(view(none, AT_CLOSED).channel, UPSELL_CHANNEL.PLUS);
});
