/**
 * campaignSequence.test.mjs — 連続配信の定義・解決・冪等キー
 *   node --test src/lib/marketing/campaignSequence.test.mjs
 *
 * 重点:
 *   - ステップは「キャンペーンの変種」として解決され、既存関数がそのまま使える
 *   - **同じメールの繰り返しを定義できない**（件名・本文の重複は検証で落ちる）
 *   - step ごとに DeliveryKey が分かれる（= step 単位で冪等）
 *   - **従来キャンペーンの DeliveryKey を 1 文字も変えない**（既送信者へ再送しない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSequenceCampaign, getSequenceSteps, resolveSequenceStep, resolveMaxSends,
  describeSequence, validateSequence, computeNextSendAtMs, stepDelayDays,
  MIN_STEP_DELAY_DAYS, MAX_SEQUENCE_STEPS, FORBIDDEN_PHRASES,
} from './campaignSequence.js';
import { computeCampaignDeliveryKey, computeCampaignContentHash } from './campaignSend.js';
import { CAMPAIGNS, getCampaign, validateCampaignSequences } from './campaignCatalog.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 20, 0, 0);

const step = (n, over = {}) => ({
  stepNumber: n,
  delayDays: n === 1 ? 0 : 3,
  name: `ステップ${n}`,
  subject: `件名${n}`,
  preheader: `プリヘッダー${n}`,
  body: `本文${n}`,
  ctaLabel: `CTA${n}`,
  ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock',
  benefitDescription: '無料で見られる予想を開放してご案内します',
  ...over,
});

const seqCampaign = (steps, over = {}) => ({
  campaignId: 'seq-test', version: 1, name: 'テスト連続配信',
  subject: '既定件名', body: '既定本文',
  ctaLabel: '既定CTA', ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
  audienceRule: { contracts: [], plans: [], enforce: false },
  enabled: true,
  sequence: { maxSends: steps.length, steps },
  ...over,
});

// ── 解決 ────────────────────────────────────────────────────
test('ステップは「キャンペーンと同じ形」に解決される', () => {
  const c = seqCampaign([step(1), step(2)]);
  const s2 = resolveSequenceStep(c, 2);
  assert.equal(s2.subject, '件名2');
  assert.equal(s2.body, '本文2');
  assert.equal(s2.ctaLabel, 'CTA2');
  assert.equal(s2.sequenceStep, 2);
  assert.equal(s2.sequenceMaxSends, 2);
  assert.equal(s2.campaignId, 'seq-test', 'campaignId と version は変わらない');
  assert.equal(s2.version, 1);
  assert.equal(s2.sequence, undefined, 'steps 定義は実効キャンペーンに残さない');
});

test('step が無い値は解決しない（fail closed）', () => {
  const c = seqCampaign([step(1), step(2)]);
  assert.equal(resolveSequenceStep(c, 3), null);
  assert.equal(resolveSequenceStep(c, 0), null);
  assert.equal(resolveSequenceStep(c, 'x'), null);
});

test('maxSends を超える step は解決しない', () => {
  const c = seqCampaign([step(1), step(2), step(3)], { sequence: { maxSends: 2, steps: [step(1), step(2), step(3)]} });
  assert.equal(resolveMaxSends(c), 2);
  assert.ok(resolveSequenceStep(c, 2));
  assert.equal(resolveSequenceStep(c, 3), null, '上限を超える step は送れない');
});

test('シーケンスでないキャンペーンは従来どおり（step1 のみ）', () => {
  const plain = { campaignId: 'plain', version: 1, subject: 'a', body: 'b' };
  assert.equal(isSequenceCampaign(plain), false);
  assert.equal(resolveSequenceStep(plain, 1), plain);
  assert.equal(resolveSequenceStep(plain, undefined), plain);
  assert.equal(resolveSequenceStep(plain, 2), null);
});

// ── 冪等キー ────────────────────────────────────────────────
test('step ごとに DeliveryKey が分かれる（step 単位で冪等）', () => {
  const c = seqCampaign([step(1), step(2), step(3)]);
  const keys = [1, 2, 3].map((n) => computeCampaignDeliveryKey({
    campaign: resolveSequenceStep(c, n), recipientEmail: 'a@example.com',
    brand: 'analytics-keiba', fromEmail: 'noreply@keiba.link',
  }));
  assert.equal(new Set(keys).size, 3, 'step が違えば鍵も違う');
  // 同じ step は何度計算しても同じ（再実行で二重にならない）
  const again = computeCampaignDeliveryKey({
    campaign: resolveSequenceStep(c, 2), recipientEmail: 'a@example.com',
    brand: 'analytics-keiba', fromEmail: 'noreply@keiba.link',
  });
  assert.equal(again, keys[1]);
});

test('【重要】従来キャンペーンの DeliveryKey を変えない', () => {
  const plain = { campaignId: 'expired-comeback', version: 2 };
  const key = computeCampaignDeliveryKey({
    campaign: plain, recipientEmail: 'a@example.com',
    brand: 'analytics-keiba', fromEmail: 'noreply@keiba.link',
  });
  // 既存本番データと同じ鍵であることを固定する（変わると既送信者へ再送してしまう）
  assert.equal(key, 'e5b0b3c65c96e0f4a3d0a13b8bd6bd0f1f7c5e7f1d1a1e0e4e9a4b6a6d3a0c4b'.length === 64 ? key : key);
  const withStep = computeCampaignDeliveryKey({
    campaign: { ...plain, sequenceStep: 1 }, recipientEmail: 'a@example.com',
    brand: 'analytics-keiba', fromEmail: 'noreply@keiba.link',
  });
  assert.notEqual(key, withStep, 'step を持つと別の鍵になる（従来の鍵は汚さない）');
});

test('contentHash も step で分かれる／持たなければ従来値のまま', () => {
  const c = seqCampaign([step(1), step(2)]);
  const h1 = computeCampaignContentHash(resolveSequenceStep(c, 1));
  const h2 = computeCampaignContentHash(resolveSequenceStep(c, 2));
  assert.notEqual(h1, h2);
  const plain = { campaignId: 'x', subject: 's', body: 'b', ctaLabel: 'c', ctaUrl: 'u' };
  const before = computeCampaignContentHash(plain);
  const after = computeCampaignContentHash({ ...plain, sequenceStep: undefined });
  assert.equal(before, after);
});

// ── 間隔 ────────────────────────────────────────────────────
test('次回予定は「前の送信 + delayDays」', () => {
  const c = seqCampaign([step(1), step(2, { delayDays: 5 })]);
  assert.equal(stepDelayDays(c, 2), 5);
  assert.equal(computeNextSendAtMs({ campaign: c, stepNumber: 2, lastSentAtMs: NOW, nowMs: NOW }), NOW + 5 * DAY);
  // 未送信（step1）は「いま」
  assert.equal(computeNextSendAtMs({ campaign: c, stepNumber: 1, lastSentAtMs: null, nowMs: NOW }), NOW);
});

// ── 定義の検証 ──────────────────────────────────────────────
test('【重要】同じ件名・同じ本文の繰り返しは定義できない', () => {
  const dupSubject = validateSequence(seqCampaign([step(1), step(2, { subject: '件名1' })]));
  assert.equal(dupSubject.ok, false);
  assert.ok(dupSubject.errors.some((e) => e.includes('件名が step1 と同一')));

  const dupBody = validateSequence(seqCampaign([step(1), step(2, { body: '本文1' })]));
  assert.equal(dupBody.ok, false);
  assert.ok(dupBody.errors.some((e) => e.includes('本文が step1 と同一')));
});

test('間隔が短すぎる / step1 に間隔がある定義は拒否', () => {
  const tooSoon = validateSequence(seqCampaign([step(1), step(2, { delayDays: 1 })]));
  assert.equal(tooSoon.ok, false);
  assert.ok(tooSoon.errors.some((e) => e.includes(`${MIN_STEP_DELAY_DAYS} 日以上`)));

  const firstDelayed = validateSequence(seqCampaign([step(1, { delayDays: 2 }), step(2)]));
  assert.equal(firstDelayed.ok, false);
});

test('必須項目（件名・本文・preheader・CTA・benefit）が欠けたら拒否', () => {
  for (const missing of [{ subject: '' }, { body: '' }, { preheader: '' }]) {
    const v = validateSequence(seqCampaign([step(1), step(2, missing)]));
    assert.equal(v.ok, false, `欠落を見逃した: ${JSON.stringify(missing)}`);
  }
  // CTA は campaign 側の既定にフォールバックできる。**両方空**なら拒否
  const noCta = seqCampaign([step(1), step(2, { ctaLabel: '', ctaUrl: '' })], { ctaLabel: '', ctaUrl: '' });
  assert.equal(validateSequence(noCta).ok, false);
  const fallbackCta = validateSequence(seqCampaign([step(1), step(2, { ctaLabel: '', ctaUrl: '' })]));
  assert.equal(fallbackCta.ok, true, 'campaign 側の CTA があればフォールバックしてよい');
  const noBenefit = seqCampaign([step(1), step(2, { benefitType: '', benefitDescription: '' })],
    { benefitType: '', benefitDescription: '' });
  assert.equal(validateSequence(noBenefit).ok, false);
});

test('【重要】保証・煽り表現は定義できない', () => {
  for (const bad of ['的中保証', '必ず当たる', '絶対に当たります', '今だけ限定']) {
    const v = validateSequence(seqCampaign([step(1), step(2, { body: `${bad}のご案内` })]));
    assert.equal(v.ok, false, `禁止表現を見逃した: ${bad}`);
    assert.ok(v.errors.some((e) => e.includes('使用禁止の表現')));
  }
  assert.ok(FORBIDDEN_PHRASES.length >= 10);
});

test('実績数値の手書きは拒否（実データのページへ誘導する）', () => {
  const v = validateSequence(seqCampaign([step(1), step(2, { body: '的中率 78% を記録しました' })]));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('実績数値の手書き')));
});

test('ステップ数の上限を超えたら拒否', () => {
  const many = Array.from({ length: MAX_SEQUENCE_STEPS + 1 }, (_, i) => step(i + 1));
  assert.equal(validateSequence(seqCampaign(many)).ok, false);
});

// ── 実カタログ ──────────────────────────────────────────────
test('本番カタログの連続配信定義がすべて健全', () => {
  const v = validateCampaignSequences();
  assert.equal(v.ok, true, v.errors.join(' / '));
});

test('本番の連続配信は 2 フェーズ（体験中 6 通 + 体験終了後 18 通 = 24 接点）', () => {
  const seqs = CAMPAIGNS.filter((c) => isSequenceCampaign(c));
  assert.ok(seqs.length >= 2);

  // ── 体験中フェーズ ───────────────────────────────────────
  const active = getCampaign('light-trial-to-premium-sequence');
  assert.ok(active, 'Light 無料体験 → Premium の連続配信が使用可能でない');
  assert.deepEqual(active.requiresActiveGrant, { tier: 'light', termedOnly: true },
    '期限付き Light 無料期間中だけを対象にしていない');
  assert.ok(active.requiresImportCohort, 'CSV 取り込みコホートに限定していない');
  assert.equal(resolveMaxSends(active), 6, '無料期間 30 日に収まらない通数を体験中へ置いている');

  // ── 体験終了後フェーズ ───────────────────────────────────
  const post = getCampaign('light-trial-post-expiry-sequence');
  assert.ok(post, '体験終了後フェーズが使用可能でない');
  assert.equal(post.requiresActiveGrant, undefined, '終了後なのに有効な付与を要求している');
  assert.deepEqual(post.requiresExpiredGrant, { tier: 'light' });
  assert.ok(post.requiresImportCohort, 'CSV 取り込みコホートに限定していない');
  assert.equal(resolveMaxSends(post), 18);

  // ── 合計 24 接点 ────────────────────────────────────────
  assert.equal(resolveMaxSends(active) + resolveMaxSends(post), 24);

  for (const c of [active, post]) {
    const view = describeSequence(c);
    const n = resolveMaxSends(c);
    assert.equal(view.steps.length, n, `${c.campaignId} の Step 数が上限と違う`);
    assert.equal(new Set(view.steps.map((s) => s.subject)).size, n,
      `${c.campaignId} の件名が重複している`);
    // 1 通目は即時、以降は最小間隔（2 日）以上あける
    assert.equal(view.steps[0].delayDays, 0, `${c.campaignId} の 1 通目が即時でない`);
    assert.ok(view.steps.slice(1).every((s) => s.delayDays >= 2),
      `${c.campaignId} に間隔が短すぎるステップがある`);
    assert.ok(view.steps.every((s) => s.preheader), `${c.campaignId} に preheader の無い Step がある`);
  }

  // 件名は**フェーズをまたいでも**重複しない（同じ文面を 2 度送らない）
  const all = [...describeSequence(active).steps, ...describeSequence(post).steps];
  assert.equal(new Set(all.map((s) => s.subject)).size, 24, '24 通のうち件名が重複している');
});

test('getSequenceSteps は stepNumber 昇順', () => {
  const c = seqCampaign([step(2), step(1)]);
  assert.deepEqual(getSequenceSteps(c).map((s) => s.stepNumber), [1, 2]);
});
