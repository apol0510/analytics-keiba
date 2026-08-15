/**
 * sequenceRender.test.mjs — 各ステップが**実際に届く HTML / text** になるか
 *   node --test src/lib/marketing/sequenceRender.test.mjs
 *
 * 重点:
 *   - HTML と text の**両方**が生成される（text だけ・HTML だけにしない）
 *   - モバイル表示の基本（幅・media query・viewport 相当）が入っている
 *   - 本番シーケンスの文面に保証表現・手書き実績・禁止 URL が無い
 *   - preheader が受信箱の一覧に出る形で入っている
 *   - benefit guard（得の宣言が無い大量配信を禁止）が各ステップで維持される
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getCampaign, renderCampaign } from './campaignCatalog.js';
import { resolveSequenceStep, getSequenceSteps, FORBIDDEN_PHRASES } from './campaignSequence.js';
import { checkBenefitForSend, BULK_THRESHOLD } from './campaignBenefit.js';
import {
  EMAIL_WIDTH, PREVIEW_UNSUBSCRIBE_URL, GRANT_EXPIRY_PLACEHOLDER, describeGrantExpiry,
} from './marketingEmailShell.js';

const CAMPAIGN = getCampaign('light-trial-to-premium-sequence');
const steps = getSequenceSteps(CAMPAIGN);

/** 管理画面のプレビューと同じ組み立て（無料期間の終了日はサンプル値で解決する） */
const renderStep = (n) => renderCampaign({
  campaign: resolveSequenceStep(CAMPAIGN, n),
  name: '山田',
  unsubscribeUrl: PREVIEW_UNSUBSCRIBE_URL,
  expiryNote: describeGrantExpiry({ durationDays: CAMPAIGN.grantDurationDays }),
});

test('本番シーケンスが取得でき、24 ステップある', () => {
  assert.ok(CAMPAIGN);
  assert.equal(steps.length, 24);
  assert.deepEqual(CAMPAIGN.requiresActiveGrant, { tier: 'light', termedOnly: true },
    '期限付き Light 無料期間中だけを対象にしていない');
});

test('無料期間の終了日は送信直前に差し替える（キュー登録時点では印のまま）', () => {
  // 受信者ごとに違う日付なので、印だけ残して dispatcher が 1 通ずつ差し替える
  const queued = renderCampaign({
    campaign: resolveSequenceStep(CAMPAIGN, 1), name: '山田', unsubscribeUrl: PREVIEW_UNSUBSCRIBE_URL,
  });
  assert.ok(queued.html.includes(GRANT_EXPIRY_PLACEHOLDER));
  // CTA のすぐ横にも終了日を出す（ファーストビューで期間が分かるように）
  assert.ok((queued.html.match(/\{\{grantExpiry\}\}/g) || []).length >= 2);
  // プレビュー（サンプル値を渡した場合）は印が残らない
  assert.equal(renderStep(1).html.includes(GRANT_EXPIRY_PLACEHOLDER), false);
});

test('各ステップが HTML と text の両方を生成する', () => {
  for (const s of steps) {
    const r = renderStep(s.stepNumber);
    assert.ok(r, `step${s.stepNumber} が描画できない`);
    assert.ok(r.html.length > 500, `step${s.stepNumber}: HTML が短すぎる`);
    assert.ok(r.text.length > 100, `step${s.stepNumber}: text が短すぎる`);
    assert.equal(r.subject, s.subject);
    // 差し込みが残っていない
    assert.equal(/\{\{|\}\}/.test(r.subject), false);
    assert.equal(r.text.includes('{{'), false);
  }
});

test('モバイル表示の基本が入っている', () => {
  const html = renderStep(1).html;
  assert.match(html, /@media only screen and \(max-width:600px\)/, 'media query が無い');
  assert.ok(html.includes(`max-width:${EMAIL_WIDTH}px`), '幅の上限が無い');
  // 横スクロールの原因になる固定大幅指定が無い
  assert.equal(/width:\s*(7|8|9)\d\d px/.test(html), false);
});

test('preheader が全ステップに入り、本文の先頭を奪わない', () => {
  for (const s of steps) {
    const r = renderStep(s.stepNumber);
    assert.ok(s.preheader, `step${s.stepNumber}: preheader が空`);
    assert.ok(r.html.includes(s.preheader), `step${s.stepNumber}: preheader が HTML に無い`);
    // プリヘッダーは非表示要素として入る（本文に二重表示しない）
    assert.match(r.html, /display:none/);
  }
});

test('CTA が全ステップにあり、本番ドメインのみ', () => {
  for (const s of steps) {
    const r = renderStep(s.stepNumber);
    const eff = resolveSequenceStep(CAMPAIGN, s.stepNumber);
    assert.ok(eff.ctaUrl.startsWith('https://analytics.keiba.link/'), `step${s.stepNumber}: CTA が本番 URL でない`);
    assert.ok(r.html.includes(eff.ctaUrl));
    assert.equal(r.html.includes('analytics.keiba.jp'), false);
    assert.equal(r.html.includes('netlify.app'), false);
  }
});

test('【重要】保証・煽り表現が本番文面に無い', () => {
  for (const s of steps) {
    const r = renderStep(s.stepNumber);
    for (const bad of FORBIDDEN_PHRASES) {
      assert.equal(r.text.includes(bad), false, `step${s.stepNumber} に「${bad}」がある`);
    }
    // 手書きの的中率・回収率も置かない（実データのページへ誘導する）
    assert.equal(/(的中率|回収率|勝率)\s*[:：]?\s*\d/.test(r.text), false, `step${s.stepNumber} に手書き実績がある`);
  }
});

test('24 通が別内容（件名・本文を使い回していない）', () => {
  const rendered = steps.map((s) => renderStep(s.stepNumber));
  assert.equal(new Set(rendered.map((r) => r.subject)).size, 24, '件名を使い回している');
  assert.equal(new Set(rendered.map((r) => r.text)).size, 24, '本文を使い回している');
});

test('【重要】連続する 2 通で同じ CTA 文言・同じ訴求角度を続けない', () => {
  // 24 通すべての CTA 文言を変えるのは不自然（「予想を見る」は何度も使う）。
  // 守りたいのは「**続けて同じものを出さない**」こと。
  const resolved = steps.map((s) => resolveSequenceStep(CAMPAIGN, s.stepNumber));
  for (let i = 1; i < resolved.length; i += 1) {
    assert.notEqual(resolved[i].ctaLabel, resolved[i - 1].ctaLabel,
      `step${i} と step${i + 1} の CTA 文言が同じ`);
  }
  const angles = resolved.map((r) => r.angle).filter(Boolean);
  assert.ok(angles.length >= 20, '訴求角度が付いていないステップが多い');
  for (let i = 1; i < angles.length; i += 1) {
    assert.notEqual(angles[i], angles[i - 1], `連続する 2 通の訴求角度が同じ（${angles[i]}）`);
  }
});

test('CTA の遷移先が 1 種類に偏っていない', () => {
  const ctas = steps.map((s) => resolveSequenceStep(CAMPAIGN, s.stepNumber).ctaUrl);
  assert.ok(new Set(ctas).size >= 4, `遷移先が ${new Set(ctas).size} 種類しかない`);
});

test('【重要】誇大表現・保証表現・架空実績を書かない', () => {
  const banned = [
    '必ず', '絶対', '確実に', '保証', '儲か', '稼げ', '損はし',
    '今だけ', '残りわずか', '急いで', '限定',
  ];
  for (const s of steps) {
    const r = resolveSequenceStep(CAMPAIGN, s.stepNumber);
    const text = [r.subject, r.headline, r.body, r.preheader, r.ctaNote].filter(Boolean).join('\n');
    for (const w of banned) {
      assert.equal(text.includes(w), false, `step${s.stepNumber} に「${w}」が入っている`);
    }
    // 実績の数値を本文へ書き写さない（％・円・的中率）
    assert.equal(/的中率\s*\d|回収率\s*\d|\d+\s*%|¥\s*[\d,]{3,}/.test(text), false,
      `step${s.stepNumber} に実績数値らしき記述がある`);
  }
});

test('配信停止リンクは本文に書かず、シェルが受信者ごとに差し込む', () => {
  const r = renderStep(1);
  assert.ok(r.html.includes(PREVIEW_UNSUBSCRIBE_URL), '配信停止 URL が差し込まれていない');
  // 本文側に配信停止の URL を書いていない
  const body = resolveSequenceStep(CAMPAIGN, 1).body;
  assert.equal(/https?:\/\//.test(body), false, '本文に URL を書かない（CTA へ寄せる）');
});

test('benefit guard: 各ステップが大量配信の条件を満たす', () => {
  for (const s of steps) {
    const eff = resolveSequenceStep(CAMPAIGN, s.stepNumber);
    const r = checkBenefitForSend({ campaign: eff, recipientCount: BULK_THRESHOLD + 1 });
    assert.equal(r.ok, true, `step${s.stepNumber}: ${r.reason}`);
    assert.ok(eff.benefitType && eff.benefitDescription);
  }
});

test('benefit guard: 宣言を外したステップは大量配信できない（維持されている）', () => {
  const eff = { ...resolveSequenceStep(CAMPAIGN, 1), benefitType: '', benefitDescription: '' };
  assert.equal(checkBenefitForSend({ campaign: eff, recipientCount: BULK_THRESHOLD + 1 }).ok, false);
});

test('氏名が無い会員でも「お客様 様」にならない', () => {
  const r = renderCampaign({ campaign: resolveSequenceStep(CAMPAIGN, 1), name: '', unsubscribeUrl: PREVIEW_UNSUBSCRIBE_URL });
  assert.equal(r.html.includes('お客様 様'), false);
  assert.ok(r.html.includes('お客様'));
});
