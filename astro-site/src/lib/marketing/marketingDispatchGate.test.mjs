/**
 * marketingDispatchGate.test.mjs — マーケティング専用送信ゲートと送信直前再検証の検証
 *   node --test src/lib/marketing/marketingDispatchGate.test.mjs
 *
 * 守る性質（2026-07-30 監査の結論）:
 *   1. マーケティングを解禁しても既存メール経路は動かない
 *   2. 既存メール経路を解禁してもマーケティングは動かない
 *   3. キュー登録から実送信までの間に状態が変わっても、送信直前に必ず再判定する
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  isMarketingJob,
  isMarketingEnqueueEnabled,
  isMarketingDispatchEnabled,
  canSharedExecutorSend,
  verifyBeforeSend,
  MARKETING_JOB_CREATED_BY,
} from './marketingDispatchGate.js';

// ── ジョブ識別 ────────────────────────────────────────────────
test('マーケティングジョブを 3 つの目印のどれからでも識別する', () => {
  assert.equal(isMarketingJob({ CreatedBy: MARKETING_JOB_CREATED_BY }), true);
  assert.equal(isMarketingJob({ TargetPlan: 'campaign:expired-comeback' }), true);
  assert.equal(isMarketingJob({ JobId: 'mkt-expired-comeback-v1-abc-1' }), true);
  assert.equal(isMarketingJob({ CreatedBy: 'ADMIN-MARKETING' }), true, '大小文字を無視する');
});

test('マーケティング以外のジョブは誤検知しない', () => {
  for (const f of [
    { CreatedBy: 'step-enqueue', JobId: 'step-abc' },
    { CreatedBy: 'admin', TargetPlan: 'premium' },
    { CreatedBy: 'newsletter', JobId: 'nl-123' },
    {}, null, undefined,
  ]) {
    assert.equal(isMarketingJob(f), false, `誤検知: ${JSON.stringify(f)}`);
  }
});

// ── 2 方向の独立性（本監査の中核）────────────────────────────────
test('【方向1】マーケティング解禁が既存メール経路を解禁しない', () => {
  const env = { MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' };
  // マーケ専用ゲートは true だが、既存メールのマスタースイッチは触れていない
  assert.equal(isMarketingDispatchEnabled(env), true);
  assert.equal(env.NEWSLETTER_AUTOMATION_ENABLED, undefined,
    'マーケ解禁が newsletter の global gate に依存している');
  // 既存ジョブは（別の gate 配下なので）このゲートの影響を受けない
  assert.equal(canSharedExecutorSend({ CreatedBy: 'step-enqueue' }, env).allowed, true);
});

test('【方向2】既存メール解禁だけではマーケティングジョブが送られない', () => {
  const env = { NEWSLETTER_AUTOMATION_ENABLED: 'true' }; // 専用ゲートは未設定
  const marketing = { CreatedBy: MARKETING_JOB_CREATED_BY, JobId: 'mkt-x-v1-abc-1' };
  const gate = canSharedExecutorSend(marketing, env);
  assert.equal(gate.allowed, false, 'newsletter 解禁でキャンペーンが飛んでいる');
  assert.equal(gate.reason, 'marketing_dispatch_disabled');
  assert.equal(isMarketingDispatchEnabled(env), false);
});

test('共有 executor はマーケティング以外のジョブを従来どおり処理する', () => {
  for (const env of [{}, { NEWSLETTER_AUTOMATION_ENABLED: 'true' }, { MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' }]) {
    assert.equal(canSharedExecutorSend({ CreatedBy: 'step-enqueue' }, env).allowed, true);
    assert.equal(canSharedExecutorSend({}, env).allowed, true);
  }
});

test('両ゲートとも "true" 以外は無効（fail closed）', () => {
  for (const v of ['1', 'yes', 'TRUE', '', undefined, null, true]) {
    assert.equal(isMarketingDispatchEnabled({ MARKETING_CAMPAIGN_DISPATCH_ENABLED: v }), false, `値 ${v}`);
    assert.equal(isMarketingEnqueueEnabled({ MARKETING_CAMPAIGN_ENABLED: v }), false, `値 ${v}`);
  }
  assert.equal(isMarketingDispatchEnabled(null), false);
  assert.equal(isMarketingEnqueueEnabled(undefined), false);
});

test('キュー登録ゲートと送信ゲートは別物（片方だけでは送れない）', () => {
  assert.equal(isMarketingDispatchEnabled({ MARKETING_CAMPAIGN_ENABLED: 'true' }), false);
  assert.equal(isMarketingEnqueueEnabled({ MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' }), false);
});

// ── 送信直前の再検証 ──────────────────────────────────────────
const OK_SETS = { providerSuppressed: new Set(), blocked: new Set(), unsubscribed: new Set(), withdrawn: new Set() };

test('通常の宛先は送信される', () => {
  const v = verifyBeforeSend({ email: 'a@example.com', ...OK_SETS });
  assert.equal(v.send, true);
  assert.equal(v.status, 'queued');
});

test('【fail closed】provider suppression を確認できないときは 1 通も送らない', () => {
  for (const bad of [undefined, null, [], 'x']) {
    const v = verifyBeforeSend({ email: 'a@example.com', providerSuppressed: bad });
    assert.equal(v.send, false, '確認できないまま送信している');
    assert.equal(v.reason, 'provider_suppression_unavailable');
  }
});

test('キュー登録後に発生した配信停止・バウンス・退会を送信直前に捕まえる', () => {
  const cases = [
    [{ providerSuppressed: new Set(['a@example.com']) }, 'provider_suppressed', 'skipped-blacklist'],
    [{ blocked: new Set(['a@example.com']) }, 'blacklist', 'skipped-blacklist'],
    [{ unsubscribed: new Set(['a@example.com']) }, 'unsubscribed', 'skipped-unsubscribed'],
    [{ withdrawn: new Set(['a@example.com']) }, 'withdrawn', 'skipped-unsubscribed'],
  ];
  for (const [over, reason, status] of cases) {
    const v = verifyBeforeSend({ email: 'a@example.com', ...OK_SETS, ...over });
    assert.equal(v.send, false, `${reason} をすり抜けている`);
    assert.equal(v.reason, reason);
    assert.equal(v.status, status, 'CampaignDeliveries の Status が許可値でない');
  }
});

test('再検証はアドレスを正規化して比較する', () => {
  const v = verifyBeforeSend({ email: '  A@Example.COM ', ...OK_SETS, blocked: new Set(['a@example.com']) });
  assert.equal(v.send, false);
});

test('空メールは送らない', () => {
  assert.equal(verifyBeforeSend({ email: '', ...OK_SETS }).send, false);
  assert.equal(verifyBeforeSend({ ...OK_SETS }).send, false);
});

// ── 送信直前の頻度ガード再計算 ────────────────────────────────
test('dry-run 後に別キャンペーンが送られていたら、送信直前で止める', () => {
  const now = Date.now();
  const recent = new Map([['a@example.com', now - 3600_000]]); // 1 時間前
  const v = verifyBeforeSend({ email: 'a@example.com', ...OK_SETS, recentContactAtMs: recent, nowMs: now });
  assert.equal(v.send, false, '24 時間以内なのに送っている');
  assert.equal(v.reason, 'recent_marketing_contact');
  assert.equal(v.status, 'skipped-frequency-cap');
});

test('24 時間より前の送信履歴なら送信直前でも通す', () => {
  const now = Date.now();
  const old = new Map([['a@example.com', now - 25 * 3600_000]]);
  assert.equal(verifyBeforeSend({ email: 'a@example.com', ...OK_SETS, recentContactAtMs: old, nowMs: now }).send, true);
});

test('頻度ガードの照合はアドレスを正規化して行う', () => {
  const now = Date.now();
  const recent = new Map([['a@example.com', now - 1000]]);
  assert.equal(verifyBeforeSend({ email: ' A@Example.COM ', ...OK_SETS, recentContactAtMs: recent, nowMs: now }).send, false);
});

test('履歴 Map が無ければ頻度ガードは働かない（他の判定は維持）', () => {
  const now = Date.now();
  assert.equal(verifyBeforeSend({ email: 'a@example.com', ...OK_SETS, nowMs: now }).send, true);
  assert.equal(verifyBeforeSend({ email: 'a@example.com', ...OK_SETS, recentContactAtMs: null, nowMs: now }).send, true);
});

test('suppression の判定は頻度ガードより先（より重い理由を出す）', () => {
  const now = Date.now();
  const recent = new Map([['a@example.com', now - 1000]]);
  const v = verifyBeforeSend({
    email: 'a@example.com', ...OK_SETS,
    providerSuppressed: new Set(['a@example.com']),
    recentContactAtMs: recent, nowMs: now,
  });
  assert.equal(v.reason, 'provider_suppressed');
});

test('返す status は CampaignDeliveries の許可値だけ', () => {
  const allowed = new Set(['queued', 'sent', 'failed', 'skipped-unsubscribed', 'skipped-blacklist',
    'skipped-converted', 'skipped-frequency-cap', 'skipped-duplicate']);
  const results = [
    verifyBeforeSend({ email: 'a@example.com', ...OK_SETS }),
    verifyBeforeSend({ email: 'a@example.com', providerSuppressed: null }),
    verifyBeforeSend({ email: '', ...OK_SETS }),
    verifyBeforeSend({ email: 'a@example.com', ...OK_SETS, unsubscribed: new Set(['a@example.com']) }),
  ];
  for (const r of results) assert.ok(allowed.has(r.status), `許可外の Status: ${r.status}`);
});

// ── 共有 executor 側の配線（実ファイル）────────────────────────────
const execSrc = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/execute-scheduled-emails-background.js', import.meta.url)), 'utf8');

test('共有 executor がゲートを呼び、通らないジョブは状態を変えずスキップする', () => {
  assert.ok(execSrc.includes('canSharedExecutorSend'), '共有 executor にゲートが入っていない');
  assert.match(execSrc, /if \(!gate\.allowed\) \{[\s\S]{0,240}?continue;/, 'スキップして次へ進んでいない');
  // スキップ時に Status を書き換えていない（PENDING のまま残す）
  const block = execSrc.slice(execSrc.indexOf('const gate = canSharedExecutorSend'), execSrc.indexOf('LAZY_LOAD形式の解析'));
  assert.equal(/method:\s*'PATCH'/.test(block), false, 'スキップ時に Airtable を書き換えている');
});

test('ゲートは受信者解決より前にある（宛先を組み立てる前に止める）', () => {
  const gateIdx = execSrc.indexOf('canSharedExecutorSend(fields');
  const recipIdx = execSrc.indexOf('recipientList = Recipients.split');
  assert.ok(gateIdx > 0 && gateIdx < recipIdx, 'ゲートが宛先解決より後ろにある');
});

// ── 専用 dispatcher（実ファイル）──────────────────────────────
const dispSrc = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/marketing-campaign-dispatch.js', import.meta.url)), 'utf8');
const dispCode = dispSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('専用 dispatcher は newsletter の global gate を参照しない', () => {
  // 説明文として名前が出るのは可。**env から読んで分岐している**ことを禁止する。
  assert.equal(/process\.env\.NEWSLETTER_AUTOMATION_ENABLED/.test(dispCode), false,
    '専用 dispatcher が既存メールのマスタースイッチを読んでいる');
  assert.equal(/env\.NEWSLETTER_AUTOMATION_ENABLED/.test(dispCode), false);
  assert.ok(dispCode.includes('isMarketingDispatchEnabled'), '専用ゲートを使っていない');
});

test('専用 dispatcher は既定 dryRun で、live は専用ゲート必須', () => {
  assert.match(dispCode, /const dryRun = req\.dryRun !== false/, '既定が dry-run でない');
  assert.match(dispCode, /if \(!dryRun && !isMarketingDispatchEnabled\(process\.env\)\)/, 'live ゲートが無い');
});

test('専用 dispatcher はマーケティングジョブ以外を絶対に処理しない', () => {
  assert.match(dispCode, /\.filter\(\(r\) => isMarketingJob\(r\.fields\)\)/, 'ジョブ種別で絞っていない');
});

test('専用 dispatcher は頻度ガードを再計算し、自ジョブの記録を除外する', () => {
  assert.ok(dispCode.includes('buildRecentContactMap'), '横断頻度の再計算が無い');
  assert.match(dispCode, /recentContactAtMs,\s*nowMs: now/, 'verifyBeforeSend へ渡していない');
  assert.match(dispCode, /if \(String\(f\.ScheduledEmailJobId \|\| ''\) === excludeJobId\) continue;/,
    '自ジョブの配信記録を除外していない（自分で自分を止めてしまう）');
  assert.match(dispCode, /f\.EmailType/, 'campaign 以外を除外していない');
});

test('専用 dispatcher はキャンペーン固有条件も送信直前に再判定する', () => {
  assert.ok(dispCode.includes('evaluateExtraAudience'), '固有条件の再判定が無い');
  assert.ok(dispCode.includes('parseTestRecipientsEnv'), 'テスト受信者ホワイトリストを読んでいない');
  // ジョブのキャンペーンを特定できないときは送らない
  assert.match(dispCode, /if \(!jobCampaign\)[\s\S]{0,200}?campaign_unavailable/,
    'キャンペーン不明のジョブを送ってしまう');
  assert.ok(dispCode.includes('campaign_mismatch'), '条件外を skipped にしていない');
});

test('専用 dispatcher は送信直前に再検証し、Customers を書かない', () => {
  assert.ok(dispCode.includes('verifyBeforeSend'), '送信直前の再検証が無い');
  // Customers は GET のみ（PATCH/POST の対象に CUSTOMERS_TABLE を渡さない）
  for (const m of dispCode.matchAll(/patchRecord\(\{[^}]*table:\s*([A-Za-z_]+)/g)) {
    assert.notEqual(m[1], 'CUSTOMERS_TABLE', 'Customers を PATCH している');
  }
  assert.equal(/table:\s*CUSTOMERS_TABLE[\s\S]{0,120}?method:\s*'(PATCH|POST|DELETE)'/.test(dispCode), false);
});

test('専用 dispatcher は配信停止リンクと List-Unsubscribe を必ず付ける', () => {
  assert.ok(dispCode.includes('List-Unsubscribe'), 'List-Unsubscribe ヘッダが無い');
  assert.ok(dispCode.includes('配信停止はこちら'), '本文に配信停止リンクが無い');
  assert.ok(dispCode.includes('functions/unsubscribe?email='), 'AK の配信停止経路を使っていない');
});

test('専用 dispatcher は宛先を 1 通ずつ送る（他受信者のアドレスを露出しない）', () => {
  assert.match(dispCode, /personalizations:\s*\[\{\s*to:\s*\[\{\s*email:\s*to\s*\}\]\s*\}\]/,
    '複数宛先を 1 通にまとめている');
});

test('専用 dispatcher は本文・宛先・鍵をログへ出さない', () => {
  const logs = [...dispCode.matchAll(/console\.(log|error|warn)\(([^\n]*)/g)].map((m) => m[2]);
  for (const l of logs) {
    for (const banned of ['SG', 'SECRET', 'email', 'Subject', 'Content', 'fields']) {
      assert.equal(l.includes(banned), false, `ログに ${banned} を出している: ${l.slice(0, 80)}`);
    }
  }
});
