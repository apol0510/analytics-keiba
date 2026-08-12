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
import { EMAIL_WIDTH, PREVIEW_UNSUBSCRIBE_URL } from './marketingEmailShell.js';

const CAMPAIGN = getCampaign('free-to-premium-sequence');
const steps = getSequenceSteps(CAMPAIGN);

const renderStep = (n) => renderCampaign({
  campaign: resolveSequenceStep(CAMPAIGN, n),
  name: '山田',
  unsubscribeUrl: PREVIEW_UNSUBSCRIBE_URL,
});

test('本番シーケンスが取得でき、4 ステップある', () => {
  assert.ok(CAMPAIGN);
  assert.equal(steps.length, 4);
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

test('4 通が別内容（件名・本文・CTA のいずれも使い回していない）', () => {
  const rendered = steps.map((s) => renderStep(s.stepNumber));
  assert.equal(new Set(rendered.map((r) => r.subject)).size, 4);
  assert.equal(new Set(rendered.map((r) => r.text)).size, 4);
  // CTA は 3 種類以上（step3/4 は同じ料金ページでよい）
  const ctas = steps.map((s) => resolveSequenceStep(CAMPAIGN, s.stepNumber).ctaUrl);
  assert.ok(new Set(ctas).size >= 3, `CTA の使い回しが多い: ${[...new Set(ctas)].join(', ')}`);
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
