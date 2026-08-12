/**
 * sequenceWiring.guard.test.mjs — 連続配信が**実経路に繋がっている**ことと安全条件
 *   node --test src/lib/marketing/sequenceWiring.guard.test.mjs
 *
 * 判定の正しさは他のテストが見る。ここで見るのは「配線」と「やってはいけないこと」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ADMIN = read('../../../netlify/functions/admin-marketing.js');
const CRON = read('../../../netlify/functions/cron-campaign-sequence.js');
const PAGE = read('../../pages/admin/premium-plus-eligibility.astro');
const PROGRESS = read('./sequenceProgress.js');
const AUTO = read('./sequenceAutomation.js');

const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

// ── 管理 API ────────────────────────────────────────────────
test('【配線】dry-run / 送信が step を解決して同じ経路を通る', () => {
  const code = codeOnly(ADMIN);
  assert.match(code, /function resolveStepCampaign\(/);
  assert.match(code, /resolveStepCampaign\(\{ campaign: baseCampaign, step: req\.step \}\)/);
  // 連続配信で step 未指定なら拒否（取り違え防止）
  assert.match(code, /連続配信です。step を指定してください/);
  // buildCampaignPlan の呼び出しは 1 か所のまま（dry-run と send が同じ計画を通る）
  assert.equal((code.match(/buildCampaignPlan\(\{/g) || []).length, 1);
});

test('【配線】状況 API が実送信と同じ進行モジュールを使う', () => {
  const code = codeOnly(ADMIN);
  assert.match(code, /action === 'sequence'/);
  assert.match(code, /buildSequenceProgress\(/);
  assert.match(code, /selectNextDueStep\(/);
  // engagement は #313 の判定をそのまま使う（別実装を作らない）
  assert.match(code, /resolveEngagementView\(\{ list, deliveries, now \}\)/);
});

test('【配線】プレビューが step ごとの HTML を返す', () => {
  const code = codeOnly(ADMIN);
  assert.match(code, /resolveStepCampaign\(\{ campaign: base, step: req\.step \}\)/);
  assert.match(code, /step: campaign\.sequenceStep \|\| null/);
});

test('【禁止】閾値・停止条件を Function へ直書きしない', () => {
  const code = codeOnly(ADMIN) + codeOnly(CRON);
  assert.equal(/delayDays\s*[:=]\s*\d/.test(code), false, '間隔を Function へ直書きしている');
  assert.equal(/maxSends\s*[:=]\s*\d/.test(code), false, '上限を Function へ直書きしている');
});

// ── 自動配信（cron）────────────────────────────────────────
test('【安全】4 ゲートが揃うまで何にも接続しない', () => {
  const code = codeOnly(CRON);
  const gateIdx = code.indexOf('readSequenceGates');
  const fetchIdx = code.indexOf('await fetch');
  assert.ok(gateIdx > 0 && fetchIdx > gateIdx, 'ゲート判定より前に通信している');
  assert.match(code, /if \(!gates\.allOpen\)/);
  assert.match(AUTO, /MARKETING_SEQUENCE_SCHEDULER_ENABLED/);
  assert.match(AUTO, /MARKETING_SEQUENCE_ARMED/);
  assert.match(AUTO, /MARKETING_CAMPAIGN_ENABLED/);
  assert.match(AUTO, /MARKETING_CAMPAIGN_DISPATCH_ENABLED/);
});

test('【安全】cron はメールを送らない・Customers を書かない', () => {
  const code = codeOnly(CRON);
  assert.equal(/sendgrid\.com\/v3\/mail\/send/.test(code), false, 'メール送信 API を叩いている');
  assert.equal(/api\.sendgrid\.com[^\n]*mail/.test(code), false);
  // Customers への書き込み（POST / PATCH）が無い
  const customerWrite = /Customers[^\n]*\n[\s\S]{0,200}?method: '(POST|PATCH)'/.test(code);
  assert.equal(customerWrite, false, 'Customers を書いている');
  assert.match(code, /ScheduledEmails/);
  assert.match(code, /performUpsert/, 'CampaignDeliveries は DeliveryKey で upsert する');
});

test('【安全】cron は全件走査しない・打ち切りを黙って通さない', () => {
  const code = codeOnly(CRON);
  assert.match(code, /listRecords/);
  assert.match(code, /assertFetchComplete/);
  assert.equal(/fetchAll\(/.test(code), false, '全件走査へ戻っている');
});

test('【安全】step1 は自動で撃たない', () => {
  assert.match(AUTO, /next\.step === 1 && allowFirstStep !== true/);
  assert.match(AUTO, /FIRST_STEP_MANUAL/);
});

test('【安全】進行は保存せず送信の事実から導く（別の進行テーブルを作らない）', () => {
  const code = codeOnly(PROGRESS);
  assert.match(code, /indexDeliveries\(/);
  assert.equal(/UPSTASH|HSET|Airtable/.test(code), false, '進行モジュールが I/O を持っている');
});

test('【安全】benefit guard を通る（得の宣言が無い大量配信を止める）', () => {
  assert.match(codeOnly(CRON), /checkBenefitForSend\(/);
});

// ── 管理画面 ────────────────────────────────────────────────
test('【表示】必要な項目が画面にある', () => {
  for (const label of [
    'キャンペーン', '自動配信', '最大配信回数', '次に送れる人数', '次回予定',
    '配信完了', '自動停止', '購入・契約成立', '反応なしで除外', 'queue 済み',
  ]) {
    assert.ok(PAGE.includes(label), `画面に項目が無い: ${label}`);
  }
  assert.match(PAGE, /id="mkSeqResult"/);
  assert.match(PAGE, /実際に届く HTML/);
});

test('【表示】プレビューは iframe を sandbox で出す（HTML をそのまま実行させない）', () => {
  const idx = PAGE.indexOf('function mkSeqPreview');
  assert.ok(idx > 0);
  const body = PAGE.slice(idx, idx + 1500);
  assert.match(body, /setAttribute\('sandbox', ''\)/);
  assert.match(body, /action: 'preview', campaignId, step/);
});

test('【表示】画面側で進行・停止条件を判定し直さない', () => {
  const idx = PAGE.indexOf('function mkSeqRender');
  const body = PAGE.slice(idx, PAGE.indexOf('function mkSeqPreview'));
  assert.equal(/nextStep\s*[+]\s*1/.test(body), false, '画面で次ステップを計算している');
  assert.equal(/delayDays\s*\*/.test(body), false, '画面で次回予定を計算している');
});
