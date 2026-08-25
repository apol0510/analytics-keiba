/**
 * lightLifetimeRestartNotice.test.mjs — Light 永久無料の再スタート案内メール
 *   node --test src/lib/marketing/lightLifetimeRestartNotice.test.mjs
 *
 * 仕様の正本: docs/spec.md §旧三連複会員は Light 永久無料として再スタートする ／
 *             docs/decisions.md 2026-08-25。
 *
 * 守る条件:
 *   1. **正規化に成功した会員にしか送れない**（失敗・未実施・別施策には届かない）
 *   2. 期限が無いことが伝わり、「期間限定」と読める表現が無い
 *   3. 三連複・馬単 Premium が戻ったと読める表現が無い
 *   4. 他商品の販売案内を混ぜない
 *   5. 同じ相手へ二度作られない（DeliveryKey が受信者ごとに 1 つ）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getCampaign, renderCampaign, matchesCampaignAudience } from './campaignCatalog.js';
import { evaluateExtraAudience, EXTRA_AUDIENCE, CAMPAIGN_MISMATCH } from './campaignAudienceRules.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { checkBenefitForSend } from './campaignBenefit.js';
import { MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';
import {
  buildLegacySanrenpukuNormalization, RESTART_GRANT_SOURCE,
} from '../entitlements/legacySanrenpukuNormalization.js';

const ID = 'light-lifetime-restart';
const NOW = Date.parse('2026-08-26T12:00:00+09:00');
const campaign = () => getCampaign(ID);

/** 正規化前（対象 18 名の形）*/
const BEFORE = {
  Email: 'a@example.invalid',
  'プラン': 'Premium Sanrenpuku',
  PlanType: '',
  '有効期限': '2026-01-18',
  Status: '',
};
/** 正規化を実際に適用した後（＝本番で成功した会員の形）*/
const AFTER = (() => {
  const built = buildLegacySanrenpukuNormalization({
    fields: BEFORE, now: Date.parse('2026-08-25T12:00:00+09:00'),
    operationId: 'legacy-srp-to-light-2026-08-25-recX', actor: 'admin',
  });
  return { ...BEFORE, ...built.fields };
})();

const audience = (fields) => evaluateExtraAudience({ campaign: campaign(), fields, nowMs: NOW });

// ── 1. 対象は正規化に成功した会員だけ ────────────────────────────────
test('キャンペーンが存在し、対象条件が正規化コホートに固定されている', () => {
  const c = campaign();
  assert.ok(c, 'キャンペーンが無効になっている');
  assert.equal(c.extraAudience, EXTRA_AUDIENCE.LIGHT_LIFETIME_RESTART);
  assert.equal(c.showGrantExpiry, undefined, '終了日を差し込む設定が付いている（期限が無いのに）');
});

test('【要件】正規化に成功した会員には届く', () => {
  assert.equal(audience(AFTER).ok, true, `対象から外れている: ${audience(AFTER).detail}`);
  assert.equal(AFTER.ComebackGrantSource, RESTART_GRANT_SOURCE, '施策名が一致していない');
});

test('【誤送信防止】正規化していない会員には構造的に届かない', () => {
  const cases = [
    ['正規化前（旧三連複・期限切れ）', BEFORE, 'not_restart_cohort'],
    ['通常の無料会員', { Email: 'b@example.invalid', 'プラン': 'Free' }, 'not_restart_cohort'],
    ['有料 Light 会員', { Email: 'c@example.invalid', 'プラン': 'Light', '有効期限': '2027-01-01', Status: 'active' }, 'not_restart_cohort'],
    ['有料 Premium 会員', { Email: 'd@example.invalid', 'プラン': 'Premium', '有効期限': '2027-01-01', Status: 'active' }, 'not_restart_cohort'],
    ['三連複 買い切り保有', { Email: 'e@example.invalid', 'プラン': 'Premium', '有効期限': '2027-01-01', Status: 'active', LifetimeSanrenpuku: true }, 'not_restart_cohort'],
    ['fields を読めない', null, 'customer_fields_unavailable'],
  ];
  for (const [label, fields, detail] of cases) {
    const r = audience(fields);
    assert.equal(r.ok, false, `${label} に届いてしまう`);
    assert.equal(r.reason, CAMPAIGN_MISMATCH, label);
    assert.equal(r.detail, detail, label);
  }
});

test('【誤送信防止】別施策で無料付与を受けた会員には届かない', () => {
  // カムバックの Light 30 日無料（2026-08-04 の施策）を受けただけの会員
  const other = {
    Email: 'f@example.invalid', 'プラン': 'Free',
    LightGrantUntil: '2026-09-03T03:38:11.307Z',
    LightGrantedAt: '2026-08-04T03:38:11.307Z',
    LightGrantOp: 'cb-light-30d-free-2026-08-04-1fcefd75',
    ComebackGrantSource: 'comeback-light-30d',
  };
  const r = audience(other);
  assert.equal(r.ok, false, '別施策の会員に届いてしまう');
  assert.equal(r.detail, 'not_restart_cohort');
});

test('【要件】正規化が途中で失敗した会員には届かない', () => {
  // 施策名だけ入って無料権利が付かなかった / 期限付きのまま / 取り消された
  const broken = [
    ['無料権利が付いていない', { ...BEFORE, ComebackGrantSource: RESTART_GRANT_SOURCE }, 'not_lifetime_grant'],
    ['期限付きのまま', {
      ...BEFORE, ComebackGrantSource: RESTART_GRANT_SOURCE,
      LightGrantUntil: '2026-09-03T03:38:11.307Z', LightGrantedAt: '2026-08-04T03:38:11.307Z',
    }, 'not_lifetime_grant'],
    ['付与が取り消されている', {
      ...AFTER, LightGrantRevokedAt: '2026-08-26T00:00:00.000Z',
    }, null],
  ];
  for (const [label, fields, detail] of broken) {
    const r = audience(fields);
    assert.equal(r.ok, false, `${label} に届いてしまう`);
    if (detail) assert.equal(r.detail, detail, label);
    else assert.ok(['not_lifetime_grant', 'grant_not_active'].includes(r.detail), `${label}: ${r.detail}`);
  }
});

test('【要件】権利が食い違う相手には届かない（事実と違う案内を送らない）', () => {
  const withSanrenpuku = { ...AFTER, LifetimeSanrenpuku: true };
  assert.equal(audience(withSanrenpuku).detail, 'has_sanrenpuku');
  const paidPremium = { ...AFTER, 'プラン': 'Premium', '有効期限': '2027-01-01', Status: 'active' };
  assert.equal(audience(paidPremium).detail, 'paid_premium_active');
});

test('契約状態では絞らない（対象は extraAudience が決める）', () => {
  // 正規化後は プラン=Free / 契約なし。audienceRule では落とさない
  const m = matchesCampaignAudience(campaign(), { contract: MK_CONTRACT.NONE, plan: MK_PLAN.FREE });
  assert.equal(m.ok, true);
  assert.equal(m.enforced, false);
});

// ── 2. 文面 ───────────────────────────────────────────────────────
test('【要件】期限が無いことが伝わり、「期間限定」と読める表現が無い', () => {
  const r = renderCampaign({ campaign: campaign(), name: '', unsubscribeUrl: 'https://analytics.keiba.link/u/x' });
  const all = `${r.subject} ${r.text}`;
  assert.ok(all.includes('期限なく無料'), '期限が無いことが書かれていない');
  assert.ok(/終了日はございません|終了日はありません/.test(all), '終了日が無いことが書かれていない');
  for (const bad of ['期間限定', '30日間', '30日無料', 'お試し期間', '無料期間中', '期限までに', '{{grantExpiry}}']) {
    assert.equal(all.includes(bad), false, `期間限定と読める表現が入っている: ${bad}`);
  }
});

test('【要件】三連複・馬単 Premium が戻ったと読める表現が無い', () => {
  const r = renderCampaign({ campaign: campaign(), name: '', unsubscribeUrl: 'x' });
  const all = `${r.subject} ${r.text}`;
  for (const bad of ['三連複', 'Premium プラン', 'Premiumプラン', 'Premium会員', 'Premium 会員',
    '馬単', '復活', '再開いただけます', '全会場']) {
    assert.equal(all.includes(bad), false, `誤解を招く表現が入っている: ${bad}`);
  }
});

test('【要件】他商品の販売案内を混ぜない', () => {
  const r = renderCampaign({ campaign: campaign(), name: '', unsubscribeUrl: 'x' });
  const all = `${r.subject} ${r.text}`;
  for (const bad of ['Premium Plus', '円OFF', '割引', 'お申し込みはこちら', '購入', 'キャンペーン価格']) {
    assert.equal(all.includes(bad), false, `販売案内が混ざっている: ${bad}`);
  }
  // 金額を 1 つも出さない
  assert.equal(/¥[0-9]/.test(all), false, '金額が入っている');
});

test('ログイン導線が正本どおり（マイページ = ログイン画面へ）', () => {
  const c = campaign();
  assert.equal(c.ctaUrl, 'https://analytics.keiba.link/dashboard/');
  const r = renderCampaign({ campaign: c, name: '', unsubscribeUrl: 'x' });
  assert.ok(r.text.includes(c.ctaUrl), 'CTA が本文に出ていない');
  assert.ok(r.text.includes('ログイン'), 'ログインの案内が無い');
  // 本文に URL を直接書かない（CTA に寄せる）
  const body = r.text.split('KEIBA Analyticsにログイン:')[0];
  assert.equal(/https?:\/\//.test(body), false, '本文に URL を書いている');
});

test('宛名は氏名があれば「◯◯ 様」／無ければ「お客様」', () => {
  const withName = renderCampaign({ campaign: campaign(), name: '山田', unsubscribeUrl: 'x' });
  assert.ok(withName.text.startsWith('山田 様'), '宛名が出ていない');
  const noName = renderCampaign({ campaign: campaign(), name: '', unsubscribeUrl: 'x' });
  assert.ok(noName.text.startsWith('お客様'), '氏名が無いときの宛名が違う');
  assert.equal(noName.text.includes('お客様 様'), false, '二重敬称');
});

test('大量配信の benefit guard を通る', () => {
  const r = checkBenefitForSend({ campaign: campaign(), recipientCount: 18 });
  assert.equal(r.ok, true, r.reason);
  const bulk = checkBenefitForSend({ campaign: campaign(), recipientCount: 1000 });
  assert.equal(bulk.ok, true, bulk.reason);
});

// ── 3. 二重送信防止 ────────────────────────────────────────────────
test('【要件】同じ相手には 1 通しか作られない（DeliveryKey が日付に依存しない）', () => {
  const c = campaign();
  const key = (recipientEmail) => computeCampaignDeliveryKey({
    campaign: c, recipientEmail, fromEmail: 'noreply@keiba.link',
  });
  const first = key('a@example.invalid');
  assert.ok(first, 'DeliveryKey を作れない');
  // 鍵は日付を含まない（campaignDate: 'fixed'）ので、いつ実行しても同じ値になる
  assert.equal(first, key('a@example.invalid'), '同じ受信者で鍵が変わる（二重送信になる）');
  assert.equal(first.includes('2026'), false, '鍵に日付が入っている');
  assert.notEqual(first, key('b@example.invalid'), '受信者が違うのに同じ鍵');
});

test('版を上げない限り再送されない（version が鍵に入る）', () => {
  const c = campaign();
  const base = computeCampaignDeliveryKey({ campaign: c, recipientEmail: 'a@example.invalid', fromEmail: 'noreply@keiba.link' });
  const bumped = computeCampaignDeliveryKey({
    campaign: { ...c, version: c.version + 1 }, recipientEmail: 'a@example.invalid', fromEmail: 'noreply@keiba.link',
  });
  assert.notEqual(base, bumped, 'version が鍵に入っていない');
});
