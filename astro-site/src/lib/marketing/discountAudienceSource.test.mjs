/**
 * discountAudienceSource.test.mjs — **0 人の campaign が 1 tick を占有しない**
 *   node --test src/lib/marketing/discountAudienceSource.test.mjs
 *
 * ## 何が起きていたか（2026-09-17 本番実測）
 *
 * ```
 * 16:00:47  Duration: 31126 ms
 * 16:01:18  campaign-discount-light  対象0 登録0 中止:no_due_recipients
 * 16:01:18  deferred [discount-premium, free-signup, light-to-premium, sanrenpuku, campaign-discount-free]
 * ```
 *
 * 1 tick の予算は 55 秒で、1 本が 25 秒（`LATEST_START_MS`）を超えると
 * `hasTimeForAnother` が次を始めない。つまり**送る相手が 0 人の campaign が
 * 31 秒かけて tick を使い切り、送る相手が居る `campaign-discount-free` が deferred される**。
 *
 * 31 秒の中身は prospect 索引（窓 2,000 件 ≒ 13 秒）＋台帳ページ＋Customers。
 * ところが Light / Premium 向けの割引は **prospect に構造的に 1 人も当たらない**。
 *
 * ## ここで固定すること
 *
 *   1. `campaign-discount-light` / `campaign-discount-premium` は `audienceSource: 'customer'`
 *   2. それは**狭める方向の宣言**であり、**選ばれる相手は 1 人も変わらない**
 *      （prospect の形をした宛先は `audienceRule` に元から一致しない）
 *   3. prospect が母集団に要る campaign（`campaign-discount-free` / `campaign-prospect-phase2`）
 *      を巻き込んでいない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getCampaign, matchesCampaignAudience } from './campaignCatalog.js';
import { resolveAudienceSource, isKnownAudienceSource } from './campaignSequence.js';
import { resolveCustomerMarketing } from './customerMarketingAudience.js';
import { prospectToCustomerRow } from './prospectSequenceAdapter.js';
import { buildProspect } from './prospectPolicy.js';
import { emailHash } from './prospectStore.js';

const NOW = Date.UTC(2026, 8, 17, 16, 0, 0);
const get = (id) => getCampaign(id, { includeDisabled: true });

/** 実際の変換経路を通して「prospect の形をした宛先」を作る（手で組み立てない） */
function prospectRow(email = 'p1@example.invalid') {
  const p = buildProspect({ email, nowMs: NOW, batchId: 'audience-test', source: 'csv' });
  // recordId は hash から作られる（本番の投入経路も hash を持つ）
  p.hash = emailHash(email);
  const row = prospectToCustomerRow({ prospect: p, nowMs: NOW });
  assert.ok(row, 'prospect を宛先の形へ変換できていない');
  return row;
}

/* ── ① 宣言されている ────────────────────────────────────────── */

for (const id of ['campaign-discount-light', 'campaign-discount-premium']) {
  test(`【最重要】${id} は母集団を Customers だけと宣言している`, () => {
    const c = get(id);
    assert.ok(c, 'campaign が見つからない');
    assert.equal(isKnownAudienceSource(c), true, '未知語を宣言している');
    assert.equal(resolveAudienceSource(c), 'customer', 'prospect 索引を読みに行ってしまう');
  });
}

/* ── ② 宣言しても選ばれる相手は変わらない（狭めるだけ）───────── */

for (const id of ['campaign-discount-light', 'campaign-discount-premium']) {
  test(`【最重要】${id} は prospect に構造的に 1 人も当たらない（宣言は純粋な絞り込み）`, () => {
    const c = get(id);
    const row = prospectRow();
    const verdict = matchesCampaignAudience(c, row.marketing);
    assert.equal(verdict.ok, false, 'prospect が当たってしまう（宣言すると対象が減る＝挙動が変わる）');
    assert.equal(verdict.enforced, true, 'enforce されていない（当たらなくても弾かれない）');
  });
}

test('【最重要】prospect の宛先は Free / 契約なしで作られる（上の前提）', () => {
  const row = prospectRow();
  const mk = row.marketing;
  assert.equal(row['出所'], 'prospect');
  assert.equal(String(row.fields['プラン']), 'Free', 'prospect が Free 以外で作られている');
  // 契約が有効・期限間近のどちらでもない（＝割引 2 本の contracts に当たらない）
  assert.notEqual(mk.contract, 'active');
  assert.notEqual(mk.contract, 'expiring_soon');
});

/* ── ③ prospect が要る campaign を巻き込まない ────────────────── */

test('【最重要】campaign-discount-free の母集団を狭めていない（prospect が本体）', () => {
  const c = get('campaign-discount-free');
  assert.notEqual(resolveAudienceSource(c), 'customer', 'prospect が母集団から外れている');
  const row = prospectRow();
  assert.equal(matchesCampaignAudience(c, row.marketing).ok, true, 'prospect が当たらなくなっている');
});

test('【最重要】campaign-prospect-phase2 は prospect 宣言のまま', () => {
  assert.equal(resolveAudienceSource(get('campaign-prospect-phase2')), 'prospect');
});

/* ── ④ 送信量・step の契約を変えていない ──────────────────────── */

for (const id of ['campaign-discount-light', 'campaign-discount-premium']) {
  test(`${id} の step 数・delayDays を変えていない`, () => {
    const c = get(id);
    const steps = c.sequence.steps;
    assert.equal(c.sequence.maxSends, steps.length, 'maxSends と step 数がズレている');
    assert.equal(steps.length, 2, 'step 数が変わった（送信量の契約）');
    assert.deepEqual(steps.map((s) => s.delayDays), [0, 6], 'delayDays が変わった');
  });
}

/* ── ⑤ どの campaign が止まったかをログから追える ───────────────── */

/**
 * ⚠️ 2026-09-17 の調査で、`window_needs_full_reload` / `no_due_recipients` の本文に
 *    campaign 名が入っておらず、**どの campaign がどの理由で止まったのかを
 *    後から突き合わせられなかった**（1 tick で複数 campaign が動くため）。
 *    中止の本文には必ず `campaignId` を載せる。
 */
test('【重要】中止の本文に campaignId が載っている（1 tick で複数 campaign が動くため）', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
    'utf8',
  );
  const needles = [
    "abort: 'prospect_full_reload_failed', campaignId: base.campaignId",
    "abort: 'window_needs_full_reload',",
    "abort: TICK_ABORT.NO_DUE, campaignId: base.campaignId",
    "abort: 'delivery_ledger_unreadable', campaignId: base.campaignId",
  ];
  for (const n of needles) assert.ok(src.includes(n), `中止の本文に campaignId が無い: ${n}`);
  // `window_needs_full_reload` は 2 箇所（事前判定と 0 人）。どちらにも載せる
  const wnfr = src.split("abort: 'window_needs_full_reload',");
  assert.equal(wnfr.length - 1, 2, 'window_needs_full_reload の箇所数が変わった');
  for (const seg of wnfr.slice(1)) {
    assert.match(seg.slice(0, 260), /campaignId: base\.campaignId/, 'window の中止に campaignId が無い');
  }
});

test('Customers 側の対象（Light 有効な方）は従来どおり当たる', () => {
  const mk = resolveCustomerMarketing({
    fields: { Email: 'c1@example.invalid', 'プラン': 'Light', Status: 'active', '有効期限': '2027-01-01' },
    nowMs: NOW,
  });
  assert.equal(matchesCampaignAudience(get('campaign-discount-light'), mk).ok, true,
    'Light 有効な方が対象から外れた');
});
