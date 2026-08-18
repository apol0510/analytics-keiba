/**
 * premiumPlusAdminEligibilityAxis.test.mjs — 「資格の軸は停止で動かさない」を固定する
 *   node --test src/lib/premiumPlus/premiumPlusAdminEligibilityAxis.test.mjs
 *
 * ## 直した事故（2026-08-18 本番で観測）
 *
 * Daniel を一時停止したところ、保存値（eligibility / override / EligibleAt）は
 * 一切変わっていないのに管理一覧で
 *   - 資格バッジが「即時販売」→「PHASE 1」に化ける
 *   - 「即時販売」の件数が 3 → 2 に減る
 * が起きた。停止中は release が denied（phase=1 / overrideApplied=false）になり、
 * それを資格表示にそのまま使っていたため。
 *
 * 確定仕様は「**資格の軸は停止で動かさない**」「**eligibility と pause は別軸**」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { eligibilityAxisRelease, eligibilityAxisFields } from './premiumPlusAdminEligibilityAxis.js';
import { PP_SALE_PAUSE_FIELDS, PP_PHASE, PP_ELIGIBILITY } from './premiumPlusRelease.js';
import { resolveUpsellForCustomer, UPSELL_CHANNEL } from '../upsell/upsellTarget.js';

/** 本番の Daniel と同じ持ち方（PII なし）: eligible + override=phase4 → 即時販売 */
const MEMBER = Object.freeze({
  'プラン': 'Premium Sanrenpuku',
  PlanType: 'Lifetime',
  Status: 'active',
  '有効期限': '2099-12-31',
  PaidAt: '2026-07-15T05:34:04.097Z',
  PremiumPlusEligibility: 'eligible',
  PremiumPlusEligibleAt: '2026-07-29T16:11:51.236Z',
  PremiumPlusReleaseOverride: 'phase4',
});
const paused = (f = MEMBER) => ({ ...f, [PP_SALE_PAUSE_FIELDS.PAUSED]: true });
const resumed = (f = MEMBER) => ({ ...f, [PP_SALE_PAUSE_FIELDS.PAUSED]: false });

const NOW = Date.parse('2026-08-18T05:00:00Z');
const rel = (fields) => resolveUpsellForCustomer({ fields, nowMs: NOW }).plusRelease;
const axis = (fields) => eligibilityAxisFields({ fields, nowMs: NOW, release: rel(fields) });

/** 管理画面 classify() と同じ判定（資格の軸だけを見る） */
function classify(row) {
  if (row.eligibility === 'blocked') return { key: 'blocked', short: '販売対象外' };
  if (row.eligibility !== 'eligible') return { key: 'review', short: '保留' };
  if (row.overrideApplied) return { key: 'immediate', short: '即時販売' };
  if (row.phase === 4) return { key: 'sale', short: '販売中' };
  return { key: 'staged', short: `PHASE ${row.phase}` };
}
const row = (fields) => ({
  eligibility: fields.PremiumPlusEligibility,
  salePaused: fields[PP_SALE_PAUSE_FIELDS.PAUSED] === true,
  ...axis(fields),
});

// ══════════════════════════════════════════════════════════════
//  1. 資格バッジは停止で変わらない
// ══════════════════════════════════════════════════════════════

test('【重要】eligible + phase4 の会員を停止しても資格バッジは「即時販売」のまま', () => {
  const before = classify(row(MEMBER));
  const during = classify(row(paused()));
  assert.equal(before.short, '即時販売');
  assert.equal(during.short, '即時販売', '停止で資格バッジが化けている');
  assert.equal(during.key, 'immediate');
});

test('【重要】停止しても phase / overrideApplied が下がらない', () => {
  const a = axis(MEMBER);
  const b = axis(paused());
  assert.deepEqual(b, a, '停止で資格の軸が動いた');
  assert.equal(b.phase, PP_PHASE.SALE);
  assert.equal(b.overrideApplied, true);
});

test('停止していない会員では release をそのまま返す（再計算しない）', () => {
  const r = rel(MEMBER);
  assert.equal(eligibilityAxisRelease({ fields: MEMBER, nowMs: NOW, release: r }), r);
});

// ══════════════════════════════════════════════════════════════
//  2〜3. 件数: immediate は不変 / salePaused だけ増減
// ══════════════════════════════════════════════════════════════

/** サーバーの counts と同じ数え方 */
const counts = (rows) => ({
  eligible: rows.filter((r) => r.eligibility === PP_ELIGIBILITY.ELIGIBLE).length,
  immediate: rows.filter((r) => r.overrideApplied).length,
  salePaused: rows.filter((r) => r.salePaused === true).length,
});

test('【重要】immediate 件数は停止前後で不変 / salePaused だけ増える', () => {
  const others = [MEMBER, MEMBER].map(row);          // 他会員 2 名
  const before = counts([row(MEMBER), ...others]);
  const after = counts([row(paused()), ...others]);

  assert.deepEqual(before, { eligible: 3, immediate: 3, salePaused: 0 });
  assert.deepEqual(after, { eligible: 3, immediate: 3, salePaused: 1 },
    '停止で immediate / eligible が減っている（本番で観測した 3→2 の再発）');
});

test('【重要】停止を解除すると件数が完全に元へ戻る', () => {
  const others = [MEMBER, MEMBER].map(row);
  const before = counts([row(MEMBER), ...others]);
  const after = counts([row(resumed()), ...others]);
  assert.deepEqual(after, before);
});

// ══════════════════════════════════════════════════════════════
//  4. 停止バッジは資格バッジと別表示
// ══════════════════════════════════════════════════════════════

test('【重要】停止は資格バッジを置き換えず、別の列/バッジで表す', () => {
  const r = row(paused());
  // 資格の軸は「即時販売」のまま、停止は salePaused が単独で持つ
  assert.equal(classify(r).short, '即時販売');
  assert.equal(r.salePaused, true);
  const page = readFileSync(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url), 'utf8');
  assert.match(page, /function pauseBadge\(r\)/, '停止用の別バッジが無い');
  const cls = page.slice(page.indexOf('function classify(r)'), page.indexOf('function classify(r)') + 700);
  assert.ok(!/salePaused/.test(cls), 'classify が停止を資格の軸へ混ぜている');
});

// ══════════════════════════════════════════════════════════════
//  5. 再開後も同じ資格状態
// ══════════════════════════════════════════════════════════════

test('【重要】停止 → 再開で資格状態が完全に一致する', () => {
  const before = row(MEMBER);
  const after = row(resumed());
  assert.deepEqual(
    [after.eligibility, after.phase, after.overrideApplied, classify(after).short],
    [before.eligibility, before.phase, before.overrideApplied, classify(before).short],
  );
  // anchor（EligibleAt）も触っていない
  assert.equal(resumed().PremiumPlusEligibleAt, MEMBER.PremiumPlusEligibleAt);
});

// ══════════════════════════════════════════════════════════════
//  6. 他会員非影響 / 顧客向けは閉じたまま
// ══════════════════════════════════════════════════════════════

test('【重要】他会員の資格表示は停止の影響を受けない', () => {
  const other = row(MEMBER);
  assert.equal(classify(other).short, '即時販売');
  assert.equal(other.salePaused, false);
  assert.equal(other.phase, PP_PHASE.SALE);
});

test('【重要】資格表示を戻しても顧客向けの停止は効いたまま', () => {
  // ここが崩れると「資格を直したら売れてしまう」最悪の回帰になる
  const v = resolveUpsellForCustomer({ fields: paused(), nowMs: NOW });
  assert.notEqual(v.channel, UPSELL_CHANNEL.PLUS, '顧客に Plus が出ている');
  assert.equal(v.plusRelease.showProductPage, false);
  assert.equal(v.plusRelease.showPurchaseCta, false);
  assert.equal(v.plusRelease.purchaseEnabled, false);
  assert.equal(v.plusRelease.salePaused, true);
});

test('資格が blocked / review の会員は停止しても資格表示が変わらない', () => {
  for (const [elig, want] of [['blocked', '販売対象外'], ['review', '保留']]) {
    const f = { ...MEMBER, PremiumPlusEligibility: elig };
    assert.equal(classify(row(f)).short, want);
    assert.equal(classify(row(paused(f))).short, want, `${elig} が停止で化けた`);
  }
});

// ══════════════════════════════════════════════════════════════
//  配線ガード
// ══════════════════════════════════════════════════════════════

test('【重要】管理一覧が資格の軸を使って phase / overrideApplied を載せている', () => {
  const fn = readFileSync(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url), 'utf8');
  assert.match(fn, /eligibilityAxisFields\(/, '資格の軸を使っていない');
  assert.match(fn, /overrideApplied: axis\.overrideApplied/);
  assert.match(fn, /phase: axis\.phase/);
  // 停止を反映した release を資格表示へ戻していない
  assert.ok(!/overrideApplied: release\.overrideApplied/.test(fn));
  assert.ok(!/^\s*phase: release\.phase,/m.test(fn));
});

test('【重要】顧客向けの値は停止を反映した release のまま', () => {
  const fn = readFileSync(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url), 'utf8');
  // state / 導線は release 由来（軸へ差し替えていない）
  assert.match(fn, /state: describeReleaseState\(release\)/, 'state が資格の軸に化けている');
  assert.ok(!/describeReleaseState\(axis\)/.test(fn));
});

test('【重要】資格の軸は顧客向け判定・申込 403 に流用されていない', () => {
  for (const rel2 of ['../../pages/api/upsell.json.js', '../../pages/api/premium-plus-stage.json.js',
    '../../pages/premium-plus.astro', '../../pages/premium-plus-v2.astro',
    '../../../netlify/functions/bank-transfer-application.js']) {
    const src = readFileSync(new URL(rel2, import.meta.url), 'utf8');
    assert.ok(!src.includes('eligibilityAxis'), `顧客向け経路が資格の軸を使っている: ${rel2}`);
  }
});
