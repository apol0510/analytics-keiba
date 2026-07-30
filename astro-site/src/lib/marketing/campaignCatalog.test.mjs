/**
 * campaignCatalog.test.mjs — キャンペーン定義とテンプレート描画の検証
 *   node --test src/lib/marketing/campaignCatalog.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMPAIGNS,
  listCampaigns,
  getCampaign,
  renderCampaign,
  matchesCampaignAudience,
  sanitizeName,
  NAME_FALLBACK,
} from './campaignCatalog.js';
import { MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';

const REQUIRED_KEYS = [
  'campaignId', 'version', 'name', 'description', 'subject', 'body',
  'ctaLabel', 'ctaUrl', 'recommendedSegments', 'audienceRule', 'enabled',
];

test('全キャンペーンが必須項目を持ち、campaignId が一意', () => {
  const ids = new Set();
  for (const c of CAMPAIGNS) {
    for (const k of REQUIRED_KEYS) {
      assert.ok(c[k] !== undefined, `${c.campaignId}: ${k} が無い`);
    }
    assert.equal(typeof c.version, 'number');
    assert.ok(c.version >= 1);
    assert.equal(ids.has(c.campaignId), false, `campaignId 重複: ${c.campaignId}`);
    ids.add(c.campaignId);
  }
  assert.ok(CAMPAIGNS.length >= 6, '初期キャンペーンが 6 本そろっていない');
});

test('要望された初期キャンペーンがすべて存在する', () => {
  for (const id of [
    'expired-comeback', 'premium-renewal', 'sanrenpuku-offer',
    'premium-plus-offer', 'dormant-reactivation', 'general-announcement',
  ]) {
    assert.ok(getCampaign(id), `${id} が無い`);
  }
});

test('CTA URL は本番 URL ルールに従う（analytics.keiba.jp / netlify.app 禁止）', () => {
  for (const c of CAMPAIGNS) {
    assert.ok(c.ctaUrl.startsWith('https://analytics.keiba.link/'), `${c.campaignId}: ${c.ctaUrl}`);
    assert.equal(c.ctaUrl.includes('analytics.keiba.jp'), false);
    assert.equal(c.ctaUrl.includes('netlify.app'), false);
  }
});

test('本文に配信停止リンクを書かない（送信基盤が自動付与するため二重になる）', () => {
  for (const c of CAMPAIGNS) {
    assert.equal(/配信停止|unsubscribe/i.test(c.body), false, `${c.campaignId} が配信停止リンクを持っている`);
  }
});

test('本文の差し込みは {{name}} だけ', () => {
  for (const c of CAMPAIGNS) {
    const placeholders = [...`${c.subject}\n${c.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    for (const p of placeholders) assert.equal(p, 'name', `${c.campaignId}: 未対応の差し込み {{${p}}}`);
  }
});

test('listCampaigns は本文を返さない（管理画面のセレクト用メタのみ）', () => {
  for (const c of listCampaigns()) {
    assert.equal(c.body, undefined);
    assert.ok(c.campaignId && c.subject && c.name);
  }
});

test('getCampaign は未知 / 無効を null にする（fail closed）', () => {
  assert.equal(getCampaign('does-not-exist'), null);
  assert.equal(getCampaign(''), null);
  assert.equal(getCampaign(null), null);
  assert.equal(getCampaign(undefined), null);
});

// ── 描画 ──────────────────────────────────────────────────────
test('氏名は差し込まれ、未指定はフォールバックになる', () => {
  const c = getCampaign('general-announcement');
  assert.ok(renderCampaign({ campaign: c, name: '山田' }).text.startsWith('山田 様'));
  assert.ok(renderCampaign({ campaign: c, name: '' }).text.startsWith(`${NAME_FALLBACK} 様`));
  assert.ok(renderCampaign({ campaign: c, name: null }).text.startsWith(`${NAME_FALLBACK} 様`));
  assert.ok(renderCampaign({ campaign: c, name: 'お客様' }).text.startsWith(`${NAME_FALLBACK} 様`));
});

test('氏名由来の HTML / プレースホルダ注入が起きない', () => {
  const c = getCampaign('general-announcement');
  // 山括弧を含む名前は名前として採用しない（HTML も差し込みも成立しない）
  const r = renderCampaign({ campaign: c, name: '<script>alert(1)</script>' });
  assert.equal(r.html.includes('<script>'), false);
  assert.ok(r.text.startsWith(`${NAME_FALLBACK} 様`));
  // 差し込み記号を含む名前も採用しない（"name 様" のような文面にしない）
  const r2 = renderCampaign({ campaign: c, name: '{{name}}' });
  assert.ok(r2.text.startsWith(`${NAME_FALLBACK} 様`));
  assert.equal(r2.html.includes('{{'), false);
});

test('未解決の差し込みが残る本文は描画しない（fail closed）', () => {
  const broken = { campaignId: 'x', version: 1, subject: 'S', body: 'hello {{unknown}}' };
  assert.equal(renderCampaign({ campaign: broken }), null);
  assert.equal(renderCampaign({}), null);
  assert.equal(renderCampaign({ campaign: null }), null);
});

test('描画結果は subject / html / text をそろえて返す', () => {
  for (const c of CAMPAIGNS) {
    const r = renderCampaign({ campaign: c, name: 'テスト' });
    assert.ok(r, `${c.campaignId} の描画に失敗`);
    assert.equal(r.subject, c.subject);
    assert.ok(r.html.includes(c.ctaUrl), 'HTML に CTA が無い');
    assert.ok(r.text.includes(c.ctaUrl), 'テキストに CTA が無い');
    assert.equal(r.html.includes('{{'), false);
  }
});

test('sanitizeName は改行を畳み、疑わしい記号はフォールバックへ倒す', () => {
  assert.equal(sanitizeName('山\n田'), '山 田', '改行は空白 1 つに畳む');
  assert.equal(sanitizeName(' 山田  太郎 '), '山田 太郎');
  assert.equal(sanitizeName('a'.repeat(100)).length, 40);
  assert.equal(sanitizeName('   '), NAME_FALLBACK);
  assert.equal(sanitizeName(123), NAME_FALLBACK);
  assert.equal(sanitizeName('{{name}}'), NAME_FALLBACK);
  assert.equal(sanitizeName('<b>x</b>'), NAME_FALLBACK);
});

// ── 想定対象（誤爆防止）────────────────────────────────────────
test('カムバック系は期限切れ限定で enforce される', () => {
  const c = getCampaign('expired-comeback');
  assert.equal(c.audienceRule.enforce, true);
  assert.deepEqual(c.audienceRule.contracts, [MK_CONTRACT.EXPIRED]);
  assert.equal(matchesCampaignAudience(c, { contract: MK_CONTRACT.EXPIRED, plan: MK_PLAN.PREMIUM }).ok, true);
  const active = matchesCampaignAudience(c, { contract: MK_CONTRACT.ACTIVE, plan: MK_PLAN.PREMIUM });
  assert.equal(active.ok, false);
  assert.equal(active.enforced, true);
  assert.equal(active.reason, 'contract_mismatch');
});

test('Premium Plus 案内は三連複保有者限定', () => {
  const c = getCampaign('premium-plus-offer');
  assert.equal(matchesCampaignAudience(c, { contract: MK_CONTRACT.ACTIVE, plan: MK_PLAN.PREMIUM }).reason, 'plan_mismatch');
  assert.equal(matchesCampaignAudience(c, { contract: MK_CONTRACT.ACTIVE, plan: MK_PLAN.PREMIUM_SANRENPUKU }).ok, true);
});

test('汎用キャンペーンは制限しないが enforce もしない', () => {
  const c = getCampaign('general-announcement');
  assert.equal(c.audienceRule.enforce, false);
  assert.equal(matchesCampaignAudience(c, { contract: MK_CONTRACT.NONE, plan: MK_PLAN.FREE }).ok, true);
});

test('顧客不明は対象にしない', () => {
  assert.equal(matchesCampaignAudience(getCampaign('general-announcement'), null).ok, false);
});

test('カタログは Premium Plus 販売資格を参照しない（販売と販促を混ぜない）', () => {
  const serialized = JSON.stringify(CAMPAIGNS);
  for (const banned of ['PremiumPlusEligibility', 'eligible', 'blocked', 'LifetimeSanrenpuku', 'PaidAt']) {
    assert.equal(serialized.includes(banned), false, `定義に ${banned} が現れている`);
  }
});
