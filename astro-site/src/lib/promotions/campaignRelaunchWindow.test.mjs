/**
 * campaignRelaunchWindow.test.mjs — **メールに書く期限と、購入画面で割り引く期間が完全に一致する**
 *   node --test src/lib/promotions/campaignRelaunchWindow.test.mjs
 *
 * ## なぜ要るか（2026-09-08 / 第 2 期の再募集にあたって）
 *
 * 第 1 期（2026-08-24 〜 09-07）は 1 通目 15,509 通を配ったところで、連続配信の不具合
 * （`CAMPAIGN_SEQUENCE.md` §11）により 2 通目以降が 1 通も出ないまま期間が終了した。
 * 期間だけ延ばして送り直すと、次の 2 つが同時に起きうる:
 *
 *   1. メールには「◯月◯日まで」と書いてあるのに、購入画面では割引が乗らない
 *      （＝「案内した額と請求額が違う」。この設計が最も避けたい事故）
 *   2. 最終 step が期間を跨ぎ、途中まで送った人に**続きが永久に届かない**
 *
 * どちらも「期間」と「文面」と「配信計画」が**別々の場所に書かれている**ときに起きる。
 * ここでは **`CAMPAIGN_WINDOW` が唯一の源であること**を機械で固定する。
 *
 * ⚠️ このテストは**期間の値そのものを固定しない**（再募集のたびに動くため）。
 *    固定するのは「どこから導出されるか」と「配り切れるか」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CAMPAIGN_WINDOW, isCampaignActive, describeCampaignDeadline,
  resolveCampaignPricing, describeCampaignForMember,
} from './campaignOffers.js';
import {
  DISCOUNT_DEADLINE, DISCOUNT_FREE_STEPS, DISCOUNT_LIGHT_STEPS, DISCOUNT_PREMIUM_STEPS,
} from '../marketing/campaignDiscountSteps.js';
import { getCampaign, CAMPAIGN_DISABLED_REASON, CAMPAIGNS } from '../marketing/campaignCatalog.js';
import { describeSequenceWindowFit, totalSequenceDays } from '../marketing/sequenceWindowFit.js';
import { resolveSequenceStep } from '../marketing/campaignSequence.js';

const DAY = 86400_000;
const startsAtMs = Date.parse(CAMPAIGN_WINDOW.startsAtIso);
const endsAtMs = Date.parse(CAMPAIGN_WINDOW.endsAtIso);
const FREE = { paidLightActive: false, paidPremiumActive: false, canViewSanrenpuku: false };
const ALLOWED = { allowed: true, reason: '', note: '' };
/** JST の暦日（期限表示と突き合わせる） */
const jstDate = (ms) => {
  const d = new Date(ms + 9 * 3600_000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
};

// ── 期間そのもの ────────────────────────────────────────────
test('期間が読めて、開始 < 終了 になっている', () => {
  assert.ok(Number.isFinite(startsAtMs), '開始が読めない');
  assert.ok(Number.isFinite(endsAtMs), '終了が読めない');
  assert.ok(endsAtMs > startsAtMs, '終了が開始より前になっている');
});

test('境界の扱い（開始は含む / 終了ちょうどは含まない）', () => {
  assert.equal(isCampaignActive(startsAtMs - 1), false, '開始前に有効になっている');
  assert.equal(isCampaignActive(startsAtMs), true, '開始ちょうどが無効になっている');
  assert.equal(isCampaignActive(endsAtMs - 1), true, '終了直前が無効になっている');
  assert.equal(isCampaignActive(endsAtMs), false, '終了ちょうどが有効のままになっている');
});

// ── 「メールの期限」＝「購入画面の割引期間」──────────────────────
test('【核心】期限表示は、割引が乗る最後の JST 暦日と完全に一致する', () => {
  // 期限文字列は「終了の 1ms 前」の JST 暦日 + 「まで」
  assert.equal(describeCampaignDeadline(), `${jstDate(endsAtMs - 1)}まで`);
  // その日は割引が乗り、翌 0:00 からは乗らない
  const lastMoment = endsAtMs - 1;
  assert.equal(
    resolveCampaignPricing({
      planName: 'Light', planType: 'Monthly', entitlements: FREE, registered: true,
      allowed: ALLOWED, nowMs: lastMoment,
    }).applied, true,
    '期限として案内した日に割引が乗らない（案内した額と請求額が食い違う）',
  );
  assert.equal(
    resolveCampaignPricing({
      planName: 'Light', planType: 'Monthly', entitlements: FREE, registered: true,
      allowed: ALLOWED, nowMs: endsAtMs,
    }).reason, 'outside_window',
    '期限を過ぎても割引が乗り続けている',
  );
});

test('【核心】メール本文の期限は 1 か所から導出され、日付を直書きしていない', () => {
  assert.equal(DISCOUNT_DEADLINE, describeCampaignDeadline(), 'メール側が別の期限を持っている');
  const all = [...DISCOUNT_FREE_STEPS, ...DISCOUNT_LIGHT_STEPS, ...DISCOUNT_PREMIUM_STEPS];
  assert.ok(all.length >= 7, `step 定義が少なすぎる: ${all.length}`);
  for (const s of all) {
    const text = [s.subject, s.preheader, s.headline, s.body, s.benefitTitle,
      ...(s.benefitItems || []), s.ctaNote || ''].join('\n');
    // 期限文字列そのもの以外に「◯年◯月◯日」を書かない
    const stripped = text.split(DISCOUNT_DEADLINE).join('');
    assert.equal(
      /\d{4}年\d{1,2}月\d{1,2}日/.test(stripped), false,
      `step${s.stepNumber}: 期限を直書きしている（期間を変えても直らない）`,
    );
    // HTML へそのまま出る Markdown 強調を残さない
    assert.equal(String(s.body).includes('**'), false, `step${s.stepNumber}: 本文に ** が残っている`);
  }
  // ⚠️ 金額・日付は**ソースに書かない**（表示文字列は offer カタログと期間から導出される）。
  //    描画結果には当然 ¥ が出るので、見るのは定義ファイルの中身。
  const src = readFileSync(
    fileURLToPath(new URL('../marketing/campaignDiscountSteps.js', import.meta.url)), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.equal(/¥\s*\d/.test(src), false, '文面の定義に金額を直書きしている');
  assert.equal(/\d{4}年\d{1,2}月\d{1,2}日/.test(src), false, '文面の定義に日付を直書きしている');
});

test('期間外は案内も出さない（1 件も返さない）', () => {
  const after = endsAtMs + DAY;
  assert.equal(describeCampaignForMember({ entitlements: FREE, nowMs: after }).offers.length, 0);
  assert.equal(describeCampaignForMember({ entitlements: FREE, nowMs: startsAtMs - DAY }).offers.length, 0);
  assert.ok(describeCampaignForMember({ entitlements: FREE, nowMs: startsAtMs + DAY }).offers.length > 0,
    '期間内なのに案内が 0 件');
});

// ── 配り切れるか（sequenceWindowFit）────────────────────────────
test('【核心】割引 3 本とも、最終 step まで期間内に配り切れる', () => {
  const bound = CAMPAIGNS.filter((c) => c.disabledReason === CAMPAIGN_DISABLED_REASON.WINDOW_CLOSED);
  assert.equal(bound.length, 3, `期間依存の割引 campaign が 3 本でない: ${bound.length}`);
  for (const c of bound) {
    const fit = describeSequenceWindowFit({ campaign: c, window: CAMPAIGN_WINDOW });
    assert.equal(fit.ok, true,
      `${c.campaignId}: 最終 step が期間を超える（${fit.totalDays} 日 / 期間 ${fit.windowDays} 日）`);
  }
});

test('【再募集の日程】step1 を送らずに step2 から再開しても期間内に収まる', () => {
  // 第 2 期は step1 を送り直さない（既に配信済み）。step2 を開始日に送る前提で確かめる。
  const free = getCampaign('campaign-discount-free', { includeDisabled: true });
  const steps = free.sequence.steps;
  const step3Delay = steps[2].delayDays;
  const step2AtMs = startsAtMs;                    // 開始日に step2
  const step3AtMs = step2AtMs + step3Delay * DAY;  // その delayDays 日後に step3
  assert.ok(step3AtMs < endsAtMs,
    `step3（${jstDate(step3AtMs)}）が期間終了（${jstDate(endsAtMs)}）に間に合わない`);
  // 期限当日まで申し込める余白が残っていること（送って即終了にしない）
  assert.ok(endsAtMs - step3AtMs >= 2 * DAY,
    'step3 から期限までが 2 日未満。届いてから検討する時間が無い');
});

test('step1 から数えた総日数も期間に収まる（第 1 期と同じ配り方でも破綻しない）', () => {
  const free = getCampaign('campaign-discount-free', { includeDisabled: true });
  const total = totalSequenceDays(free);
  const windowDays = (endsAtMs - startsAtMs) / DAY;
  assert.ok(total < windowDays, `総日数 ${total} 日 ≧ 期間 ${windowDays} 日`);
});

// ── 再送を起こさない（version を上げない）────────────────────────
test('【安全】割引 3 本の version を上げていない（上げると step1 が全員へ再送される）', () => {
  for (const id of ['campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium']) {
    const c = getCampaign(id, { includeDisabled: true });
    assert.equal(c.version, 1,
      `${id}: version が上がっている。DeliveryKey は campaign × version × step で決まるため、`
      + '上げると既に送った step1 が「未送信」に戻り、全員へ再送される');
  }
});

test('【安全】step1 の文面は第 1 期のまま（送信済みの人に別内容を紐づけない）', () => {
  // step1 は第 1 期に配信済み。再募集で書き換えるのは step2 以降だけ。
  const s1 = DISCOUNT_FREE_STEPS[0];
  assert.match(s1.subject, /有料プラン割引のご案内/);
  assert.equal(s1.delayDays, 0);
  // step2 以降は「再募集」であることが分かる文面になっている
  assert.match(
    String(DISCOUNT_FREE_STEPS[1].body), /一度締め切って/,
    'step2 が再募集であることを説明していない（前の期限との食い違いが伝わらない）',
  );
});

test('step を解決しても期限は同じ 1 か所から来る', () => {
  const free = getCampaign('campaign-discount-free', { includeDisabled: true });
  for (const n of [1, 2, 3]) {
    const step = resolveSequenceStep(free, n);
    const text = [step.subject, step.body, step.benefitTitle].join('\n');
    if (text.includes('まで')) {
      assert.ok(text.includes(DISCOUNT_DEADLINE),
        `step${n}: 期限の文字列が単一源と違う`);
    }
  }
});
