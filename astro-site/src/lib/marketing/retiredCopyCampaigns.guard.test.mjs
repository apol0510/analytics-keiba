/**
 * 三連複の訴求統一（2026-10-03 MK 確定・docs/PREDICTION_ACQUISITION.md §6）の固定。
 * 「点数を絞る」「少点数」中心の旧訴求を、送信されうるメール・有料/販売ページに出さない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CAMPAIGNS } from './campaignCatalog.js';
import { RETIRED_COPY_CAMPAIGNS, isRetiredCopyCampaign } from './retiredCopyCampaigns.js';
import { buildCampaignPlan } from './campaignSend.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8');
const OLD_PITCH = /点数を絞|少点数|自動で絞り込|絞り込み機能|自動絞り込み|AI絞り込み|[67]〜9点|7-9点/;
const stepsOf = (c) => (c.sequence?.steps?.length ? c.sequence.steps : [{ ...c, stepNumber: 0 }]);
const textOf = (c, s) => [s.subject, s.preheader, s.headline, s.body, s.ctaLabel, s.ctaNote, ...(s.benefitItems || []), s.benefitDescription].filter(Boolean).join('\n');

test('送信されうるメールに三連複の旧訴求（点数を絞る・少点数）が無い', () => {
  for (const c of CAMPAIGNS) {
    if (isRetiredCopyCampaign(c.campaignId) || c.testOnly) continue;
    for (const s of stepsOf(c)) {
      const t = textOf(c, s);
      if (!/三連複|Sanrenpuku/.test(t)) continue;
      assert.equal(OLD_PITCH.test(t), false, `${c.campaignId} step${s.stepNumber}: 三連複の旧訴求が残っている`);
    }
  }
});

test('停止リストは実在する campaign・理由付き／旧訴求が無いのに止めていない／止めた campaign は送信計画を作らない', () => {
  for (const [id, why] of Object.entries(RETIRED_COPY_CAMPAIGNS)) {
    const c = CAMPAIGNS.find((x) => x.campaignId === id);
    assert.ok(c, id);
    assert.ok(why.length > 10, id);
    assert.ok(stepsOf(c).some((s) => OLD_PITCH.test(textOf(c, s))), `${id}: 旧訴求が無いなら停止リストから外す`);
    const plan = buildCampaignPlan({ campaign: c, selected: [{ recordId: 'recA', email: 'a@example.com' }], fromEmail: 'noreply@keiba.link', nowMs: Date.now() });
    assert.equal(plan.error, 'retired_copy', id);
    assert.equal(plan.recipients.length, 0);
  }
});

test('有料・販売ページの三連複導線は「レース選別」の訴求に統一（旧訴求の文言が無い）', () => {
  const pages = [
    'src/pages/premium-prediction/jra.astro', 'src/pages/premium-prediction/nankan.astro',
    'src/pages/premium-sanrenpuku.astro', 'src/pages/premium-sanrenpuku-jra.astro',
    'src/pages/sanrenpuku-demo.astro', 'src/pages/dashboard.astro',
    'src/pages/archive-sanrenpuku/[year]/[month].astro', 'src/pages/archive-sanrenpuku-jra/[year]/[month].astro',
    'src/pages/archive-sanrenpuku-all/index.astro',
  ];
  for (const p of pages) {
    const s = read(p);
    // 表示されるマークアップだけを見る（frontmatter / CSS / スクリプト / コメントは除く）
    const body = s.slice(s.indexOf('---', 3) + 3)
      .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    assert.equal(OLD_PITCH.test(body), false, `${p}: 三連複の旧訴求が残っている（${(body.match(OLD_PITCH) || [])[0]}）`);
  }
  for (const p of ['src/pages/premium-prediction/jra.astro', 'src/pages/premium-prediction/nankan.astro']) {
    assert.match(read(p), /今日、三連複で狙うべきレース/, p);
    assert.match(read(p), /推奨レースの予想を取得する/, p);
  }
  assert.match(read('src/components/acquisition/SrpRecommendedRaces.astro'), /推奨レースの予想を取得する/);
  assert.match(read('src/components/acquisition/AcquisitionRaceList.astro'), /product === 'srp' \? '推奨レースの予想を取得する' : '予想を取得する'/);
});
