/**
 * campaignSend.test.mjs — 送信対象の確定・除外・冪等性の検証
 *   node --test src/lib/marketing/campaignSend.test.mjs
 *
 * 重点:
 *   - 二重送信が構造的に起きない（DeliveryKey / 既送信突合 / planFingerprint）
 *   - 除外は必ず理由付きで数えられる（黙って落とさない）
 *   - Customers / 決済フィールドへ書く値を一切作らない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCampaignPlan,
  buildDeliveryRecords,
  chunkRecipients,
  computeCampaignDeliveryKey,
  computePlanFingerprint,
  assertOnlyDeliveryFields,
  summarizeHistory,
  summarizeCampaignRuns,
  MK_EXCLUSION,
  MK_FORBIDDEN_CUSTOMER_FIELDS,
  MK_FORBIDDEN_DELIVERY_FIELDS,
  CD_WRITABLE_FIELDS,
  MAX_RECIPIENTS_PER_SEND,
  RECIPIENTS_PER_JOB,
  MARKETING_MIN_INTERVAL_MS,
  isRecentMarketingContact,
} from './campaignSend.js';
import { getCampaign, CAMPAIGNS } from './campaignCatalog.js';
import { resolveCustomerMarketing, MK_CONTRACT } from './customerMarketingAudience.js';

const NOW = Date.UTC(2026, 7, 3, 1, 0);
const FROM = 'noreply@keiba.link';

/**
 * 送信計画のロジック検証にはカタログの方針（有効/無効・対象条件）を持ち込まない。
 * 制限なし・有効なテスト用キャンペーンを使い、カタログ側の検証は campaignCatalog.test.mjs で行う。
 */
const general = Object.freeze({
  campaignId: 'test-generic', version: 1, name: 'テスト用',
  subject: 'テスト件名', body: '{{salutation}}\n\n本文',
  ctaLabel: '詳細', ctaUrl: 'https://analytics.keiba.link/',
  audienceRule: { contracts: [], plans: [], enforce: false },
  enabled: true,
});
const comeback = getCampaign('expired-comeback');

/** 顧客 1 件（Airtable fields → marketing 判定まで通す） */
function customer(recordId, over = {}, opts = {}) {
  const fields = { Email: `${recordId}@example.com`, Status: 'active', 'プラン': 'Premium', '有効期限': '2020-01-01', ...over };
  return { recordId, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW, ...opts }) };
}

/** provider suppression は必須引数。既定は「空 Set（誰も suppress されていない）」 */
const plan = (selected, campaign = general, deliveredKeys, opts = {}) =>
  buildCampaignPlan({
    campaign, selected, deliveredKeys,
    providerSuppressed: opts.providerSuppressed === undefined ? new Set() : opts.providerSuppressed,
    softBounced: opts.softBounced,
    brand: 'analytics-keiba', fromEmail: FROM, nowMs: NOW,
  });

// ── 対象確定 ──────────────────────────────────────────────────
test('送信可能な顧客だけが対象になり、除外は理由付きで数えられる', () => {
  const p = plan([
    customer('r1'),
    customer('r2', { UnsubscribedAnalyticsKeiba: true }),
    // 退会（課金停止）は除外理由にならない → r3 も送信対象
    customer('r3', { WithdrawalRequested: true }),
    customer('r4', { Email: '' }),
  ]);
  assert.equal(p.ok, true);
  assert.equal(p.counts.selected, 4);
  assert.equal(p.counts.recipients, 2, '退会者が除外されている');
  assert.equal(p.counts.excluded, 2);
  assert.equal(p.counts.byReason.unsubscribed, 1);
  assert.equal(p.counts.byReason.withdrawn, undefined, '退会が除外理由に出ている');
  assert.equal(p.counts.byReason.no_email, 1);
  assert.deepEqual(p.recipients.map((r) => r.email).sort(), ['r1@example.com', 'r3@example.com']);
});

test('blacklist は対象から外れる', () => {
  const p = plan([customer('r1', {}, { blacklistEmails: new Set(['r1@example.com']) })]);
  assert.equal(p.counts.recipients, 0);
  assert.equal(p.counts.byReason.blacklist, 1);
});

test('同一アドレスの重複は 1 通だけ（重複は理由付きで除外）', () => {
  const p = plan([customer('r1'), { ...customer('r2'), marketing: customer('r1').marketing }]);
  assert.equal(p.counts.recipients, 1);
  assert.equal(p.counts.byReason[MK_EXCLUSION.DUPLICATE], 1);
});

test('存在しない recordId は unknown_customer として除外', () => {
  const p = plan([{ recordId: 'ghost', fields: null, marketing: null }]);
  assert.equal(p.counts.recipients, 0);
  assert.equal(p.counts.byReason[MK_EXCLUSION.UNKNOWN_CUSTOMER], 1);
});

test('enforce キャンペーンは想定外の契約状態を除外する（誤爆防止）', () => {
  const active = customer('r1', { '有効期限': '2099-01-01' });
  assert.equal(active.marketing.contract, MK_CONTRACT.ACTIVE);
  const p = plan([active], comeback);
  assert.equal(p.counts.recipients, 0, '有効会員へカムバックを送ろうとしている');
  assert.equal(p.counts.byReason[MK_EXCLUSION.CONTRACT_MISMATCH], 1);
});

test('enforce しないキャンペーンはセグメントが違っても送れる', () => {
  const p = plan([customer('r1', { '有効期限': '2099-01-01' })], general);
  assert.equal(p.counts.recipients, 1);
});

test('上限件数を超える計画は作らない', () => {
  const many = Array.from({ length: MAX_RECIPIENTS_PER_SEND + 1 }, (_, i) => customer(`r${i}`));
  const p = plan(many);
  assert.equal(p.ok, false);
  assert.ok(String(p.error).startsWith('too_many_recipients'));
  assert.equal(p.recipients.length, 0);
});

test('不正入力は計画を作らない（fail closed）', () => {
  const base = { providerSuppressed: new Set(), fromEmail: FROM, nowMs: NOW };
  assert.equal(buildCampaignPlan({ ...base, campaign: null, selected: [] }).ok, false);
  assert.equal(buildCampaignPlan({ ...base, campaign: general, selected: 'x' }).ok, false);
  assert.equal(buildCampaignPlan({ ...base, campaign: general, selected: [], fromEmail: '' }).ok, false);
});

// ── provider suppression（本監査の中核）──────────────────────────
test('【fail closed】provider suppression を確認できないと計画自体を作らない', () => {
  for (const bad of [undefined, null, [], 'x', new Map()]) {
    const p = buildCampaignPlan({
      campaign: general, selected: [customer('r1')], providerSuppressed: bad,
      brand: 'analytics-keiba', fromEmail: FROM, nowMs: NOW,
    });
    assert.equal(p.ok, false, '確認できないまま送信計画を作っている');
    assert.equal(p.error, 'provider_suppression_unavailable');
    assert.equal(p.recipients.length, 0);
  }
});

test('SendGrid 側で suppressed の宛先は除外される（AK 台帳に無くても）', () => {
  const c = customer('r1');
  assert.equal(c.marketing.sendable, true, 'AK 側の判定では送信可');
  const p = plan([c], general, undefined, { providerSuppressed: new Set(['r1@example.com']) });
  assert.equal(p.counts.recipients, 0);
  assert.equal(p.counts.byReason[MK_EXCLUSION.PROVIDER_SUPPRESSED], 1);
});

test('provider suppression の照合は正規化して行う（大文字・空白の差で漏らさない）', () => {
  const p = plan([customer('r1')], general, undefined, { providerSuppressed: new Set(['R1@Example.com'.toLowerCase()]) });
  assert.equal(p.counts.byReason[MK_EXCLUSION.PROVIDER_SUPPRESSED], 1);
});

test('AK のソフトバウンス履歴も販促メールでは除外する', () => {
  const p = plan([customer('r1')], general, undefined, { softBounced: new Set(['r1@example.com']) });
  assert.equal(p.counts.recipients, 0);
  assert.equal(p.counts.byReason[MK_EXCLUSION.SOFT_BOUNCE], 1);
});

test('除外の優先順: suppression → provider → soft → 重複 → 既送信', () => {
  // 配信停止かつ provider suppressed なら、AK 側の理由（配信停止）が先に立つ
  const both = customer('r1', { UnsubscribedAnalyticsKeiba: true });
  const p = plan([both], general, undefined, { providerSuppressed: new Set(['r1@example.com']) });
  assert.equal(p.counts.byReason.unsubscribed, 1);
  assert.equal(p.counts.byReason[MK_EXCLUSION.PROVIDER_SUPPRESSED], undefined);
});

// ── キャンペーン横断 頻度ガード（24 時間）────────────────────────
test('24 時間以内に別キャンペーンを送っていたら除外する', () => {
  const recent = customer('r1', {}, { history: { lastSentAtMs: NOW - 3 * 3600_000, sentCount: 1 } });
  const p = plan([recent]);
  assert.equal(p.counts.recipients, 0, '24 時間以内に 2 通目を送ろうとしている');
  assert.equal(p.counts.byReason[MK_EXCLUSION.RECENT_MARKETING_CONTACT], 1);
});

test('24 時間の境界（ちょうど 24 時間経過は送れる）', () => {
  const at = (ms) => plan([customer('r1', {}, { history: { lastSentAtMs: NOW - ms, sentCount: 1 } })]).counts.recipients;
  assert.equal(at(MARKETING_MIN_INTERVAL_MS - 1000), 0, '24 時間未満で送っている');
  assert.equal(at(MARKETING_MIN_INTERVAL_MS), 1);
  assert.equal(at(MARKETING_MIN_INTERVAL_MS + 1000), 1);
});

test('hard safety floor は 24 時間（定数を下げていない）', () => {
  assert.equal(MARKETING_MIN_INTERVAL_MS, 24 * 60 * 60 * 1000);
});

test('送信履歴が無い / 読めない場合は頻度ガードで止めない', () => {
  assert.equal(plan([customer('r1')]).counts.recipients, 1);
  for (const bad of [null, undefined, NaN, 'x']) {
    assert.equal(isRecentMarketingContact({ lastSentAtMs: bad, nowMs: NOW }), false);
  }
});

test('未来日時の送信履歴は不正として送らない側へ倒す', () => {
  assert.equal(isRecentMarketingContact({ lastSentAtMs: NOW + 1000, nowMs: NOW }), true);
});

test('頻度ガードは既送信判定より後（同一キャンペーンは already_delivered が優先）', () => {
  const c = customer('r1', {}, { history: { lastSentAtMs: NOW - 1000, sentCount: 1 } });
  const first = plan([c]);
  // 履歴があるので通常は recent_marketing_contact だが、同一キャンペーン既送信ならそちらを出す
  const delivered = new Set([computeCampaignDeliveryKey({
    campaign: general, recipientEmail: 'r1@example.com', brand: 'analytics-keiba', fromEmail: FROM,
  })]);
  const second = plan([c], general, delivered);
  assert.equal(first.counts.byReason[MK_EXCLUSION.RECENT_MARKETING_CONTACT], 1);
  assert.equal(second.counts.byReason[MK_EXCLUSION.ALREADY_DELIVERED], 1);
});

// ── キャンペーン固有の追加条件 ────────────────────────────────
test('使用停止中のキャンペーンは計画を作らない', () => {
  const disabled = { ...general, enabled: false };
  const p = plan([customer('r1')], disabled);
  assert.equal(p.ok, false);
  assert.equal(p.error, 'campaign_disabled');
  assert.equal(p.recipients.length, 0);
});

test('本文が初期テンプレートのままなら計画を作らない（fail closed）', () => {
  const p = plan([customer('r1')], { ...general, isPlaceholderTemplate: true });
  assert.equal(p.ok, false);
  assert.equal(p.error, 'template_not_configured');
});

test('CTA URL 未設定なら計画を作らない', () => {
  const p = plan([customer('r1')], { ...general, ctaUrl: '' });
  assert.equal(p.ok, false);
  assert.equal(p.error, 'cta_not_configured');
});

test('未知の extraAudience は全員除外（定義ミスで全員へ送らない）', () => {
  const p = plan([customer('r1')], { ...general, extraAudience: 'does-not-exist' });
  assert.equal(p.counts.recipients, 0);
  assert.equal(p.counts.byReason[MK_EXCLUSION.CAMPAIGN_MISMATCH], 1);
});

// ── 冪等性 ────────────────────────────────────────────────────
test('DeliveryKey は 受信者 × campaignId × version で決まる（日付では変わらない）', () => {
  const k = (over) => computeCampaignDeliveryKey({
    campaign: { campaignId: 'c1', version: 1, ...over?.campaign },
    recipientEmail: over?.email ?? 'a@example.com',
    brand: 'analytics-keiba', fromEmail: FROM,
  });
  assert.equal(k(), k(), '同じ入力なら同じ key');
  assert.notEqual(k(), k({ email: 'b@example.com' }));
  assert.notEqual(k(), k({ campaign: { version: 2 } }), 'version を上げれば再送できる');
  assert.notEqual(k(), k({ campaign: { campaignId: 'c2' } }));
  assert.equal(k({ email: 'A@Example.com ' }), k(), 'email は正規化して比較');
});

test('既に送信済み/予約済みの DeliveryKey は除外される', () => {
  const c = customer('r1');
  const first = plan([c]);
  const delivered = new Set(first.recipients.map((r) => r.deliveryKey));
  const second = plan([c], general, delivered);
  assert.equal(second.counts.recipients, 0, '同じキャンペーンが二度送られようとしている');
  assert.equal(second.counts.byReason[MK_EXCLUSION.ALREADY_DELIVERED], 1);
});

test('planFingerprint は対象集合が変われば変わる（dry-run→send の TOCTOU 防止）', () => {
  const a = plan([customer('r1'), customer('r2')]);
  const b = plan([customer('r1'), customer('r2')]);
  const c = plan([customer('r1')]);
  assert.equal(a.planFingerprint, b.planFingerprint);
  assert.notEqual(a.planFingerprint, c.planFingerprint);
  // 並び順が違っても同じ集合なら同じ（管理画面の選択順に依存しない）
  const d = plan([customer('r2'), customer('r1')]);
  assert.equal(a.planFingerprint, d.planFingerprint);
  // キャンペーンが違えば別
  assert.notEqual(a.planFingerprint, computePlanFingerprint({ campaign: comeback, recipients: a.recipients }));
});

// ── 書き込みフィールドの封じ込め ──────────────────────────────────
test('CampaignDeliveries レコードは許可フィールドだけを持つ', () => {
  const p = plan([customer('r1')]);
  const records = buildDeliveryRecords({ campaign: general, recipients: p.recipients, jobIdByEmail: new Map(), nowMs: NOW });
  assert.equal(records.length, 1);
  const keys = Object.keys(records[0].fields);
  for (const k of keys) assert.ok(CD_WRITABLE_FIELDS.includes(k), `許可外フィールド ${k}`);
  assert.equal(records[0].fields.Status, 'queued');
  assert.equal(records[0].fields.EmailType, 'campaign');
});

test('決済・権限・販売資格フィールドを一切書かない', () => {
  const p = plan([customer('r1')]);
  const records = buildDeliveryRecords({ campaign: general, recipients: p.recipients, jobIdByEmail: new Map(), nowMs: NOW });
  const serialized = JSON.stringify(records);
  for (const f of MK_FORBIDDEN_DELIVERY_FIELDS) {
    assert.equal(serialized.includes(`"${f}"`), false, `禁止フィールド ${f} を書こうとしている`);
  }
  // 決済メール v2 / 権限 / Plus 販売資格の名前が許可リストへ紛れ込んでいないこと
  for (const f of MK_FORBIDDEN_CUSTOMER_FIELDS) {
    if (f === 'Status') continue; // CampaignDeliveries 自身の列（queued/sent/…）
    assert.equal(CD_WRITABLE_FIELDS.includes(f), false, `許可リストに ${f} が入っている`);
  }
});

test('assertOnlyDeliveryFields は許可外を弾く', () => {
  assert.equal(assertOnlyDeliveryFields({ DeliveryKey: 'k', Status: 'queued' }), true);
  assert.equal(assertOnlyDeliveryFields({ DeliveryKey: 'k', PaymentEmailSent: true }), false);
  assert.equal(assertOnlyDeliveryFields({}), false);
  assert.equal(assertOnlyDeliveryFields(null), false);
});

test('宛先はジョブ単位に分割される', () => {
  const many = Array.from({ length: RECIPIENTS_PER_JOB * 2 + 3 }, (_, i) => ({ email: `r${i}@example.com` }));
  const chunks = chunkRecipients(many);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, RECIPIENTS_PER_JOB);
  assert.equal(chunks[2].length, 3);
});

// ── 履歴集計 ──────────────────────────────────────────────────
test('履歴集計は campaign だけを見る（step / race_main を混ぜない）', () => {
  const recs = [
    { fields: { EmailType: 'campaign', RecipientEmail: 'A@Example.com', Status: 'sent', SentAt: '2026-07-01T00:00:00.000Z', CampaignType: 'c1:v1' } },
    { fields: { EmailType: 'campaign', RecipientEmail: 'a@example.com', Status: 'sent', SentAt: '2026-07-20T00:00:00.000Z', CampaignType: 'c2:v1' } },
    { fields: { EmailType: 'step', RecipientEmail: 'a@example.com', Status: 'sent', SentAt: '2026-07-25T00:00:00.000Z' } },
  ];
  const h = summarizeHistory(recs);
  const a = h.get('a@example.com');
  assert.equal(a.sentCount, 2, 'step メールが混ざっている');
  assert.equal(a.lastCampaignId, 'c2:v1');
});

test('キャンペーン集計は provider 受理と実配信を混同しない状態のみ数える', () => {
  const runs = summarizeCampaignRuns([
    { fields: { EmailType: 'campaign', CampaignType: 'c1:v1', Status: 'queued', QueuedAt: '2026-07-01T00:00:00.000Z' } },
    { fields: { EmailType: 'campaign', CampaignType: 'c1:v1', Status: 'sent', SentAt: '2026-07-02T00:00:00.000Z' } },
    { fields: { EmailType: 'campaign', CampaignType: 'c1:v1', Status: 'failed' } },
    { fields: { EmailType: 'campaign', CampaignType: 'c1:v1', Status: 'skipped-blacklist' } },
  ]);
  assert.equal(runs.length, 1);
  assert.deepEqual(
    { queued: runs[0].queued, sent: runs[0].sent, failed: runs[0].failed, skipped: runs[0].skipped },
    { queued: 1, sent: 1, failed: 1, skipped: 1 },
  );
  assert.equal(Object.keys(runs[0]).includes('delivered'), false, 'delivered を勝手に作らない');
});

// ── ソース guard ──────────────────────────────────────────────
const sendSrc = readFileSync(fileURLToPath(new URL('./campaignSend.js', import.meta.url)), 'utf8');
const code = sendSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('送信計画モジュールはメールを送らない / Airtable を叩かない', () => {
  // 表示ラベルに 'SendGrid' の語が出るのは正当なので、**API 呼び出しの形**で検査する
  for (const banned of ['fetch(', 'api.sendgrid.com', 'api.airtable.com', 'process.env', 'mail/send']) {
    assert.equal(code.toLowerCase().includes(banned.toLowerCase()), false, `${banned} を含んでいる`);
  }
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.filter((i) => i.includes('providerSuppression')), [],
    '純粋モジュールが provider I/O を import している');
});

test('全キャンペーンで DeliveryKey が衝突しない', () => {
  const keys = new Set();
  for (const c of CAMPAIGNS) {
    const k = computeCampaignDeliveryKey({ campaign: c, recipientEmail: 'a@example.com', brand: 'analytics-keiba', fromEmail: FROM });
    assert.ok(k, `${c.campaignId} の key を作れない`);
    assert.equal(keys.has(k), false, `${c.campaignId} の key が他と衝突`);
    keys.add(k);
  }
});
