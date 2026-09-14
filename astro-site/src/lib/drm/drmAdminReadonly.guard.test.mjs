/**
 * drmAdminReadonly.guard.test.mjs — 管理画面の **read-only な DRM 表示** の契約
 *   node --test src/lib/drm/drmAdminReadonly.guard.test.mjs
 *
 * 2026-09-14 の本番実測で見つかった 2 件を固定する:
 *   1. cohort 表示が campaign を渡さず、**Premium 会員を三連複購入済みと誤表示**していた
 *   2. `action=sequence` が新しい campaign で 504 / `audience_not_narrowable` になり、
 *      **進行を画面から確認できなかった**
 *
 * ⚠️ ここは表示面だけを見る。**cron / 実送信経路の契約は変えない**ことも併せて固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CAMPAIGNS, getCampaign } from '../marketing/campaignCatalog.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { resolveResponseState, RESPONSE } from './drmResponseState.js';
import { FUNNEL_STAGES } from './drmFunnel.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ADMIN = read('../../../netlify/functions/admin-marketing.js');
const CRON = read('../../../netlify/functions/cron-campaign-sequence.js');
const PAGE = read('../../pages/admin/drm.astro');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const DAY = 86400_000;
const NOW = Date.UTC(2026, 8, 14);

// ══════════════════════════════════════════════════════════════════
//  ① 反応層の購入判定は campaign ごと（誤表示を作らない）
// ══════════════════════════════════════════════════════════════════

/** Premium 契約が有効で、三連複は未保有の人 */
function premiumMember() {
  const fields = {
    Email: 'p@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
    有効期限: new Date(NOW + 300 * DAY).toISOString(),
  };
  return resolveCustomerMarketing({ fields, nowMs: NOW });
}

test('【本件】Premium 会員を三連複の段で「購入済み」にしない', () => {
  const marketing = premiumMember();
  const camp = getCampaign('sanrenpuku-upsell-sequence', { includeDisabled: true });
  const state = resolveResponseState({
    marketing, touches: [], measured: { open: true, click: false }, campaign: camp,
  });
  assert.notEqual(state.state, RESPONSE.PURCHASED,
    'Premium 会員が三連複の段で購入済みに見えている（誤表示）');
  assert.equal(state.state, RESPONSE.NOT_SENT, 'まだ 1 通も送っていないので未送信のはず');
});

test('【対比】同じ人でも前段（無料 → 有料）では購入済み', () => {
  const marketing = premiumMember();
  for (const id of ['free-signup-onboarding', 'light-to-premium-sequence']) {
    const camp = getCampaign(id, { includeDisabled: true });
    const state = resolveResponseState({
      marketing, touches: [], measured: { open: true, click: false }, campaign: camp,
    });
    assert.equal(state.state, RESPONSE.PURCHASED, `${id}: 前段が停止していない`);
  }
});

test('【配線】cohort 表示が campaign を渡している', () => {
  const code = codeOnly(ADMIN);
  const i = code.indexOf('async function handleDrmCohort(');
  assert.ok(i > 0, 'cohort のハンドラが無い');
  const body = code.slice(i, code.indexOf('async function ', i + 10));
  assert.match(body, /resolveResponseState\(\{[\s\S]{0,240}campaign: base,/,
    'cohort が resolveResponseState へ campaign を渡していない（誤表示に戻る）');
});

test('【安全】全段の育成で、この誤表示が起きないこと', () => {
  const marketing = premiumMember();
  for (const s of FUNNEL_STAGES) {
    const camp = CAMPAIGNS.find((c) => c.campaignId === s.nurtureCampaignId);
    if (!camp) continue;
    const state = resolveResponseState({
      marketing, touches: [], measured: { open: true, click: false }, campaign: camp,
    });
    // 到達目標を持っていない段では purchased にならない
    const owns = s.goal.some((g) => (g === 'premium' && marketing.premiumActive)
      || (g === 'light' && marketing.lightActive)
      || (g === 'sanrenpuku' && marketing.hasSanrenpuku));
    assert.equal(state.state === RESPONSE.PURCHASED, owns,
      `${s.stage}: 購入判定が到達目標と一致していない`);
  }
});

// ══════════════════════════════════════════════════════════════════
//  ② 進行の下見（台帳から読む・read-only・bounded）
// ══════════════════════════════════════════════════════════════════

test('【配線】進行の下見が台帳から読む（受信対象の全件走査をしない）', () => {
  const code = codeOnly(ADMIN);
  assert.match(code, /action === 'drmProgress'/, '進行の下見の経路が無い');
  const i = code.indexOf('async function handleDrmProgress(');
  assert.ok(i > 0);
  const body = code.slice(i, code.indexOf('\nasync function ', i + 10));
  // 台帳（CampaignDeliveries）を campaignType で絞って読む
  assert.match(body, /fetchDeliveryPage\(\{/, '台帳から読んでいない');
  // 受信対象を先に読む経路（audience_not_narrowable の原因）を使わない
  assert.equal(body.includes('loadCampaignAudience('), false,
    '受信対象を先に読んでいる（新 campaign で 400 / 504 に戻る）');
});

test('【安全】進行の下見は書かない・送らない', () => {
  const code = codeOnly(ADMIN);
  const i = code.indexOf('async function handleDrmProgress(');
  const body = code.slice(i, code.indexOf('\nasync function ', i + 10));
  for (const bad of ["method: 'POST'", "method: 'PATCH'", 'buildDeliveryRecords(',
    'buildScheduledEmailFields(', 'dispatch']) {
    assert.equal(body.includes(bad), false, `進行の下見が ${bad} を含む（read-only ではない）`);
  }
  assert.match(body, /sideEffects: 'none'/);
});

test('【安全】読み切れなければ数字を出さない（部分を全体にしない）', () => {
  const code = codeOnly(ADMIN);
  const i = code.indexOf('async function handleDrmProgress(');
  const body = code.slice(i, code.indexOf('\nasync function ', i + 10));
  assert.match(body, /complete: false/);
  assert.match(body, /progress_requires_scan/);
  assert.match(body, /too_many_recipients/);
  // 上限を持つ
  assert.match(code, /DRM_PROGRESS_MAX_ROWS = \d+/);
  assert.match(code, /DRM_PROGRESS_MAX_RECIPIENTS = \d+/);
});

test('【重要】進行と反応は実配信と同じ単一源を通る（画面と実配信がズレない）', () => {
  const code = codeOnly(ADMIN);
  const i = code.indexOf('async function handleDrmProgress(');
  const body = code.slice(i, code.indexOf('\nasync function ', i + 10));
  assert.match(body, /buildSequenceProgress\(\{/, '進行を自前で数えている');
  assert.match(body, /loadResponseByEmail\(\{/, '反応を自前で組み立てている');
  assert.equal(/resolveResponseState\(/.test(body), false, '反応の判定を自前で実装している');
});

test('【表示】誰も入っていない campaign でもエラーにせず「入っていない」と返す', () => {
  const code = codeOnly(ADMIN);
  const i = code.indexOf('async function handleDrmProgress(');
  const body = code.slice(i, code.indexOf('\nasync function ', i + 10));
  assert.match(body, /inSequence: 0/);
  assert.match(body, /nothing_sent_yet/);
});

test('【配線】画面から進行の下見を呼べる', () => {
  assert.match(PAGE, /action: 'drmProgress'/, '画面が進行の下見を呼んでいない');
  assert.match(PAGE, /drm-progress/, '進行のボタン / 表示先が無い');
});

// ══════════════════════════════════════════════════════════════════
//  ③ cron / 実送信経路は変えていない
// ══════════════════════════════════════════════════════════════════

test('【不変】cron は進行の下見を使わない（送信経路を触っていない）', () => {
  const code = codeOnly(CRON);
  assert.equal(code.includes('drmProgress'), false, 'cron が表示用の経路を使っている');
  assert.equal(code.includes('handleDrmProgress'), false);
  // cron 側の既存の入口・反応の配線はそのまま
  assert.match(code, /loadResponseByEmail\(\{/);
  assert.match(code, /planAutoStartEntries\(\{/);
  assert.match(code, /allowFirstStep: autoStartDecl !== null && autoStartGate\.open === true/);
});
