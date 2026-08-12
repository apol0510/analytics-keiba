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
const TRIAL_CRON = read('../../../netlify/functions/cron-light-trial-grant.js');
const AUTOGRANT = read('../comeback/lightTrialAutoGrant.js');
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
  // I/O そのものを持っていないこと（`fromAirtableFields` のような純粋な変換は可）
  assert.equal(/UPSTASH|HSET|await fetch|api\.airtable\.com/.test(code), false, '進行モジュールが I/O を持っている');
});

test('【安全】benefit guard を通る（得の宣言が無い大量配信を止める）', () => {
  assert.match(codeOnly(CRON), /checkBenefitForSend\(/);
});

test('【安全】シーケンスは無料付与を書かない（付与は admin-comeback-grants だけ）', () => {
  for (const [name, src] of [['progress', PROGRESS], ['automation', AUTO], ['cron', CRON], ['admin', ADMIN]]) {
    const code = codeOnly(src);
    assert.equal(/LightGrantUntil|LightGrantedAt|PROMO_WRITABLE_FIELDS|buildGrantFields/.test(code), false,
      `${name} が無料付与フィールドを書こうとしている`);
  }
  // 付与済みかどうかは既存の単一源で**読むだけ**
  assert.match(codeOnly(PROGRESS), /resolvePromotionalGrants\(/);
  assert.match(codeOnly(PROGRESS), /GRANT_REQUIRED|GRANT_EXPIRED/);
});

// ── 無料体験の入口（自動付与）────────────────────────────────
test('【安全】自動付与は 6 ゲートが揃うまで Customers を書かない', () => {
  const code = codeOnly(TRIAL_CRON);
  const gateIdx = code.indexOf('readAutoGrantGates');
  const patchIdx = code.indexOf("method: 'PATCH'");
  assert.ok(gateIdx > 0 && patchIdx > gateIdx, 'ゲート判定より前に書き込んでいる');
  for (const env of [
    'COMEBACK_GRANT_FIELDS_READY', 'COMEBACK_GRANT_ENABLED',
    'LIGHT_TRIAL_AUTOGRANT_ENABLED', 'LIGHT_TRIAL_AUTOGRANT_ARMED',
    'MARKETING_CAMPAIGN_ENABLED', 'MARKETING_CAMPAIGN_DISPATCH_ENABLED',
  ]) assert.match(AUTOGRANT, new RegExp(env), `ゲートが欠けている: ${env}`);
});

test('【安全】付与の形は既存 planner を使う（複製しない）', () => {
  const code = codeOnly(TRIAL_CRON) + codeOnly(AUTOGRANT);
  assert.match(code, /buildComebackPlan\(/);
  // 付与フィールドを自前で組み立てていない
  assert.equal(/LightGrantUntil:\s*/.test(code), false, '付与フィールドを直接組み立てている');
  assert.equal(/buildGrantFields\(/.test(code), false, '低レベル API を直接叩いている');
});

test('【重要】付与 → Step1 の順序が保証されている', () => {
  const code = codeOnly(TRIAL_CRON);
  const grantIdx = code.indexOf('applyGrants(');
  const queueIdx = code.indexOf('buildCampaignPlan(');
  assert.ok(grantIdx > 0 && queueIdx > grantIdx, 'Step1 の計画が付与より前にある');
  assert.match(code, /recipientsAfterGrant\(/);
  assert.match(code, /grantedIds\.length === 0/, '付与 0 件でも送ろうとしている');
});

test('【安全】dry-run は書き込まない（管理シークレット必須）', () => {
  const code = codeOnly(TRIAL_CRON);
  assert.match(code, /if \(dryRun\) \{[\s\S]{0,600}sideEffects: 'none'/);
  assert.match(code, /x-admin-secret/);
});

test('【重要】コホート判定は取り込みの正本を使う（新しい旗を作らない）', () => {
  const code = codeOnly(AUTOGRANT) + codeOnly(read('../crm/importedCohort.js'));
  assert.match(code, /IMPORT_SOURCE_PREFIX/);
  assert.match(code, /assertCohortObservable\(/);
  // コホート判定用の独自フラグ名を発明していない
  assert.equal(/LightTrialCohort|IsCsvImported|TrialTarget/.test(code), false);
});

// ── 管理画面 ────────────────────────────────────────────────
test('【表示】無料体験の入口（付与候補・除外理由・CSV 対象総数）が画面にある', () => {
  for (const label of [
    'CSV 取り込みの対象総数', '付与候補', '除外理由', 'バッチ別', '自動付与',
  ]) assert.ok(PAGE.includes(label), `画面に項目が無い: ${label}`);
  assert.match(PAGE, /id="mkTrialResult"/);
  assert.match(PAGE, /action: 'trialGrant'/);
  // 画面側で付与しない（判定も付与もサーバー）
  const idx = PAGE.indexOf('function mkTrialRender');
  const body = PAGE.slice(idx, idx + 2000);
  assert.equal(/LightGrant|PATCH|付与する/.test(body), false, '画面から付与しようとしている');
});

test('【安全】下見 API は付与しない（read-only）', () => {
  const code = codeOnly(ADMIN);
  assert.match(code, /function handleTrialGrantPreview\(/);
  assert.match(code, /selectAutoGrantCandidates\(/);
  // 関数の中身だけを切り出す（次の関数宣言まで）
  const start = code.indexOf('async function handleTrialGrantPreview');
  const rest = code.slice(start + 10);
  const end = rest.indexOf('\nasync function ');
  const body = rest.slice(0, end > 0 ? end : 3000);
  assert.equal(/method: '(PATCH|POST|DELETE)'/.test(body), false, '下見が書き込んでいる');
  assert.match(body, /sideEffects: 'none'/);
  assert.match(body, /付与もキュー登録もしていません/);
});

test('【表示】必要な項目が画面にある', () => {
  for (const label of [
    'キャンペーン', '自動配信', '最大配信回数', '次に送れる人数', '次回予定',
    '配信完了', '自動停止', '購入・契約成立', '反応なしで除外', 'queue 済み',
    '無料体験がまだ', '無料体験の期間終了', '期限なし付与', '対象コホート外',
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
