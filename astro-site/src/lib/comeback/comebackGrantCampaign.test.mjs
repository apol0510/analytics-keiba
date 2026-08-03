/**
 * comebackGrantCampaign.test.mjs
 *   node --test src/lib/comeback/comebackGrantCampaign.test.mjs
 *
 * 「配った特典」と「送る文面」がズレないこと、テスト用文面が既定にならないことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANT_CAMPAIGN_BY_OFFER, GRANT_CAMPAIGN_BLOCK, GRANT_CAMPAIGN_BLOCK_LABEL,
  TEMPLATE_MISSING_NOTICE, recommendCampaignForGrant, pickInitialCampaign, describeCta,
  inferGrantOfferId, buildGrantOffersFromKinds,
} from './comebackGrantCampaign.js';
import { getCampaign, listCampaigns } from '../marketing/campaignCatalog.js';

const CAMPAIGNS = listCampaigns();
const handoff = (grantOffers) => ({ operationId: 'cb-x-2026-08-03-abcd1234', grantedCount: 28, grantOffers });

// ── 対応表 ────────────────────────────────────────────────────

test('Light 30日無料 → 専用キャンペーン', () => {
  const r = recommendCampaignForGrant({ light: 'light-30d-free' });
  assert.equal(r.campaignId, 'comeback-light-30d-granted');
  assert.equal(r.reason, null);
});

test('対応表に無い付与種別は自動選択しない（近い文面を当てにいかない）', () => {
  for (const offers of [
    { light: 'light-lifetime-free' },
    { light: 'light-90d-free' },
    { premium: 'premium-30d-free' },
    { premium: 'premium-lifetime-free' },
    { premium: 'premium-annual-free' },
  ]) {
    const r = recommendCampaignForGrant(offers);
    assert.equal(r.campaignId, null, `${JSON.stringify(offers)} を自動選択した`);
    assert.equal(r.reason, GRANT_CAMPAIGN_BLOCK.TEMPLATE_MISSING);
    assert.ok(r.label.length > 0);
  }
});

test('Light と Premium の同時付与は自動選択しない', () => {
  const r = recommendCampaignForGrant({ light: 'light-30d-free', premium: 'premium-30d-free' });
  assert.equal(r.campaignId, null);
  assert.equal(r.reason, GRANT_CAMPAIGN_BLOCK.MULTI_TIER);
});

test('付与内容が不明なら自動選択しない', () => {
  assert.equal(recommendCampaignForGrant({}).reason, GRANT_CAMPAIGN_BLOCK.NO_GRANT);
  assert.equal(recommendCampaignForGrant().reason, GRANT_CAMPAIGN_BLOCK.NO_GRANT);
  assert.equal(recommendCampaignForGrant({ light: '  ' }).reason, GRANT_CAMPAIGN_BLOCK.NO_GRANT);
});

test('対応表は 1 対 1 で、存在するキャンペーンだけを指す', () => {
  for (const [offerId, campaignId] of Object.entries(GRANT_CAMPAIGN_BY_OFFER)) {
    assert.ok(getCampaign(campaignId), `${offerId} → ${campaignId} が実在しない`);
  }
});

test('すべての理由コードに文言がある', () => {
  for (const code of Object.values(GRANT_CAMPAIGN_BLOCK)) {
    assert.ok(GRANT_CAMPAIGN_BLOCK_LABEL[code], `${code} の文言が無い`);
  }
  assert.match(TEMPLATE_MISSING_NOTICE, /手動で選/);
});

// ── 初期選択 ──────────────────────────────────────────────────

test('Light 30日付与の引き継ぎで専用キャンペーンが初期選択される', () => {
  const r = pickInitialCampaign({ campaigns: CAMPAIGNS, handoff: handoff({ light: 'light-30d-free' }) });
  assert.equal(r.campaignId, 'comeback-light-30d-granted');
  assert.equal(r.matchedGrant, true);
});

test('運用テスト専用カナリアは初期選択されない', () => {
  // 引き継ぎがある場合
  const withHandoff = pickInitialCampaign({ campaigns: CAMPAIGNS, handoff: handoff({ light: 'light-lifetime-free' }) });
  assert.notEqual(withHandoff.campaignId, 'marketing-canary');
  // 引き継ぎが無い通常運用でも
  const plain = pickInitialCampaign({ campaigns: CAMPAIGNS });
  assert.notEqual(plain.campaignId, 'marketing-canary');
  // カタログ上はカナリアが先頭で使用可能なままであること（前提が変わったら気づけるように）
  assert.equal(CAMPAIGNS[0].campaignId, 'marketing-canary');
  assert.equal(CAMPAIGNS[0].testOnly, true);
  assert.equal(CAMPAIGNS[0].usable, true);
});

test('対応文面が無い引き継ぎでは「未設定」を伝えて手動選択を促す', () => {
  const r = pickInitialCampaign({ campaigns: CAMPAIGNS, handoff: handoff({ light: 'light-lifetime-free' }) });
  assert.equal(r.matchedGrant, false);
  assert.equal(r.reason, GRANT_CAMPAIGN_BLOCK.TEMPLATE_MISSING);
  assert.ok(r.label.length > 0);
});

test('使用停止中のキャンペーンは初期選択しない', () => {
  const list = [
    { campaignId: 'disabled-one', usable: false, testOnly: false },
    { campaignId: 'ok-one', usable: true, testOnly: false },
  ];
  assert.equal(pickInitialCampaign({ campaigns: list }).campaignId, 'ok-one');
});

test('推奨キャンペーンが使用停止なら初期選択しない（fail closed）', () => {
  const list = [
    { campaignId: 'comeback-light-30d-granted', usable: false, testOnly: false },
    { campaignId: 'ok-one', usable: true, testOnly: false },
  ];
  const r = pickInitialCampaign({ campaigns: list, handoff: handoff({ light: 'light-30d-free' }) });
  assert.equal(r.campaignId, 'ok-one');
  assert.equal(r.matchedGrant, false);
});

test('候補が無ければ空を返す（適当に選ばない）', () => {
  assert.equal(pickInitialCampaign({ campaigns: [] }).campaignId, '');
  assert.equal(pickInitialCampaign({}).campaignId, '');
});

// ── 新キャンペーンの中身 ────────────────────────────────────────

test('Light 30日無料付与済み案内の既定文面', () => {
  const c = getCampaign('comeback-light-30d-granted');
  assert.ok(c, 'キャンペーンが存在しない');
  // v1 → v2: 共通 HTML シェルへ載せ替え、件名・プリヘッダー・特典カードを追加
  assert.equal(c.version, 2);
  assert.equal(c.name, 'Light 30日無料付与済み案内');
  assert.equal(c.subject, '【KEIBA Analytics】Lightプラン30日無料のご案内');
  assert.equal(c.badge, '30日間無料');
  assert.equal(c.headline, 'Lightプランを30日間無料でご利用いただけます');
  assert.match(c.preheader, /お申し込み不要/);
  assert.ok(Array.isArray(c.benefitItems) && c.benefitItems.length >= 3, '特典カードの項目が無い');
  assert.equal(c.showGrantExpiry, true, '無料期間の終了日を出す設定になっていない');
  assert.equal(c.grantDurationDays, 30);
  assert.match(c.body, /Lightプランを30日間無料でご利用いただけるようにいたしました/);
  assert.match(c.body, /お申し込みやお支払いの手続きは必要ありません/);
  // 宛名は共通シェルが本文の前に出す（本文には書かない）
  assert.equal(c.body.includes('{{salutation}}'), false, '本文に宛名が二重に入っている');
  assert.equal(c.testOnly === true, false, 'テスト専用になっている');
  assert.equal(c.enabled, true);
});

test('本文に URL を書かない（リンクは CTA だけ）', () => {
  const c = getCampaign('comeback-light-30d-granted');
  assert.equal(/https?:\/\//.test(c.body), false, `本文に URL がある: ${c.body}`);
  assert.equal(/analytics\.keiba/.test(c.body), false, '本文にドメインがある');
});

test('CTA は /dashboard/ 固定', () => {
  const c = getCampaign('comeback-light-30d-granted');
  assert.equal(c.ctaLabel, 'KEIBA Analyticsにログイン');
  assert.equal(c.ctaUrl, 'https://analytics.keiba.link/dashboard/');
});

test('契約状態では絞らない（付与成功が対象条件）', () => {
  const c = getCampaign('comeback-light-30d-granted');
  assert.equal(c.audienceRule.enforce, false, '契約条件で付与成功者を除外してしまう');
  assert.deepEqual(c.audienceRule.contracts, []);
});

test('既存キャンペーンと campaignId が衝突しない（DeliveryKey が分かれる）', () => {
  const ids = CAMPAIGNS.map((c) => `${c.campaignId}:v${c.version}`);
  assert.equal(new Set(ids).size, ids.length, 'campaignId × version が重複している');
  assert.ok(ids.includes('comeback-light-30d-granted:v2'));
  // v1 で送った相手へ v2 を送れる（DeliveryKey が別になる）
  assert.equal(ids.includes('comeback-light-30d-granted:v1'), false, 'v1 が残っている');
  // 過去に送った他キャンペーンとも別の鍵になる
  for (const other of ['expired-comeback:v2', 'comeback-offer:v2', 'premium-renewal:v2', 'dormant-reactivation:v2']) {
    assert.notEqual('comeback-light-30d-granted:v2', other);
  }
});

// ── CTA の表示 ────────────────────────────────────────────────

test('通常キャンペーンは CTA のラベルと URL をそのまま出す', () => {
  const c = getCampaign('comeback-light-30d-granted');
  const d = describeCta(c);
  assert.equal(d.label, 'KEIBA Analyticsにログイン');
  assert.equal(d.url, 'https://analytics.keiba.link/dashboard/');
  assert.equal(d.perRecipient, false);
  assert.match(d.note, /本文に URL は書きません/);
});

test('受信者ごとの専用 URL は実 URL を出さない（token 境界を保つ）', () => {
  const d = describeCta({ ctaLabel: '申込ページを開く', ctaUrl: 'https://analytics.keiba.link/offer/?t={{offerUrl}}' });
  assert.equal(d.perRecipient, true);
  assert.equal(d.url, '', '未発行の URL を画面へ出している');
  assert.match(d.note, /お客様ごとの専用 URL/);
});

test('CTA 未設定でも落ちない', () => {
  const d = describeCta({});
  assert.equal(d.label, '');
  assert.equal(d.url, '');
  assert.match(d.note, /設定されていません/);
  assert.equal(describeCta().label, '');
});

// =========================================================================
// 実データからの逆引き（再引き継ぎ）
// =========================================================================

test('30 日付与 → light-30d-free → 専用キャンペーン', () => {
  const offerId = inferGrantOfferId({ tier: 'light', lifetime: false, durationDays: 30 });
  assert.equal(offerId, 'light-30d-free');
  assert.equal(recommendCampaignForGrant({ light: offerId }).campaignId, 'comeback-light-30d-granted');
});

test('永久付与 → light-lifetime-free（対応文面は未設定なので自動選択しない）', () => {
  const offerId = inferGrantOfferId({ tier: 'light', lifetime: true, durationDays: null });
  assert.equal(offerId, 'light-lifetime-free');
  assert.equal(recommendCampaignForGrant({ light: offerId }).campaignId, null);
});

test('混在は逆引きしない（違う条件の人へ同じ文面を送らない）', () => {
  assert.equal(inferGrantOfferId({ tier: 'light', lifetime: null, durationDays: null, mixed: true }), null);
});

test('対応表に無い日数は逆引きしない（「近いから 30 日」にしない）', () => {
  assert.equal(inferGrantOfferId({ tier: 'light', lifetime: false, durationDays: 31 }), null);
  assert.equal(inferGrantOfferId({ tier: 'light', lifetime: false, durationDays: 7 }), null);
  assert.equal(inferGrantOfferId({ tier: 'light', lifetime: false, durationDays: 90 }), 'light-90d-free');
});

test('Premium 側も逆引きできる', () => {
  assert.equal(inferGrantOfferId({ tier: 'premium', lifetime: false, durationDays: 30 }), 'premium-30d-free');
  assert.equal(inferGrantOfferId({ tier: 'premium', lifetime: true }), 'premium-lifetime-free');
});

test('壊れた入力では逆引きしない', () => {
  assert.equal(inferGrantOfferId({}), null);
  assert.equal(inferGrantOfferId(), null);
  assert.equal(inferGrantOfferId({ tier: 'sanrenpuku', lifetime: true }), null);
  assert.equal(inferGrantOfferId({ tier: 'light', lifetime: false, durationDays: NaN }), null);
});

test('kinds から引き継ぎ票の grantOffers を作る', () => {
  const offers = buildGrantOffersFromKinds({
    light: { lifetime: false, durationDays: 30, mixed: false },
    premium: null,
  });
  assert.deepEqual(offers, { light: 'light-30d-free', premium: null });
  // 逆引きできない tier は null（自動選択させない）
  assert.deepEqual(
    buildGrantOffersFromKinds({ light: { lifetime: false, durationDays: 45, mixed: false } }),
    { light: null, premium: null },
  );
  assert.deepEqual(buildGrantOffersFromKinds({}), { light: null, premium: null });
});

test('本番実測（2026-08-03 / 28 名）の付与は 30 日として読める', () => {
  // LightGrantedAt 2026-08-03T09:25:10Z → LightGrantUntil 2026-09-02 = 30 日
  const kinds = { light: { count: 28, lifetime: false, durationDays: 30, mixed: false } };
  const offers = buildGrantOffersFromKinds(kinds);
  assert.equal(offers.light, 'light-30d-free');
  assert.equal(recommendCampaignForGrant(offers).campaignId, 'comeback-light-30d-granted');
});
