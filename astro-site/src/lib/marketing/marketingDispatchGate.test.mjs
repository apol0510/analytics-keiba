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

// ── 共有 executor は marketing job を常に送らない（2026-07-30 恒久化）────────
/** env の全組み合わせ。どれでも marketing job は共有 executor から送れてはいけない */
const ENV_MATRIX = [
  ['A: newsletter=true / dispatch=true', { NEWSLETTER_AUTOMATION_ENABLED: 'true', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' }],
  ['B: newsletter=true / dispatch=false', { NEWSLETTER_AUTOMATION_ENABLED: 'true', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'false' }],
  ['C: newsletter=false / dispatch=true', { NEWSLETTER_AUTOMATION_ENABLED: 'false', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' }],
  ['D: 両方未設定', {}],
  ['E: 両方 true 相当の別表記', { NEWSLETTER_AUTOMATION_ENABLED: 'TRUE', MARKETING_CAMPAIGN_DISPATCH_ENABLED: '1' }],
];

const MARKETING_JOBS = [
  ['CreatedBy', { CreatedBy: MARKETING_JOB_CREATED_BY }],
  ['TargetPlan', { TargetPlan: 'campaign:marketing-canary' }],
  ['JobId', { JobId: 'mkt-marketing-canary-v1-abc-1' }],
  ['全部そろい', { CreatedBy: MARKETING_JOB_CREATED_BY, TargetPlan: 'campaign:x', JobId: 'mkt-x-v1-a-1' }],
];

test('【A/B/C】env のどの組み合わせでも共有 executor は marketing job を送らない', () => {
  for (const [label, env] of ENV_MATRIX) {
    for (const [jobLabel, fields] of MARKETING_JOBS) {
      // env を渡しても渡さなくても結果は同じ（env で開く余地が無い）
      for (const gate of [canSharedExecutorSend(fields), canSharedExecutorSend(fields, env)]) {
        assert.equal(gate.allowed, false, `${label} × ${jobLabel}: 共有 executor から送れてしまう`);
        assert.equal(gate.reason, 'marketing_job_dedicated_dispatcher_only');
      }
    }
  }
});

test('【D】非 marketing ジョブ（newsletter / step / race_main / expiry）の挙動は不変', () => {
  const nonMarketing = [
    { CreatedBy: 'step-enqueue', JobId: 'step-abc' },
    { CreatedBy: 'admin', TargetPlan: 'premium' },
    { CreatedBy: 'newsletter', JobId: 'nl-123' },
    { CreatedBy: 'expiry-notification' },
    { TargetPlan: 'all' },
    {}, null, undefined,
  ];
  for (const [label, env] of ENV_MATRIX) {
    for (const fields of nonMarketing) {
      for (const gate of [canSharedExecutorSend(fields), canSharedExecutorSend(fields, env)]) {
        assert.equal(gate.allowed, true, `${label}: 非 marketing ジョブが止まっている ${JSON.stringify(fields)}`);
        assert.equal(gate.reason, null);
      }
    }
  }
});

test('canSharedExecutorSend は env を一切参照しない（構造的に開けない）', () => {
  // 引数として env を受け取らない = 将来 env 次第で開く条件を作れない
  assert.equal(canSharedExecutorSend.length, 1, '引数が 1 個（fields のみ）でない');
  const src = canSharedExecutorSend.toString();
  for (const banned of ['env', 'process', 'DISPATCH_ENABLED', 'AUTOMATION_ENABLED']) {
    assert.equal(src.includes(banned), false, `関数本体が ${banned} を参照している`);
  }
});

test('専用ゲートは dispatcher 側の判定としては維持される', () => {
  // 共有 executor では使わないが、marketing-campaign-dispatch の live 判定には必要
  assert.equal(isMarketingDispatchEnabled({ MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' }), true);
  assert.equal(isMarketingDispatchEnabled({}), false);
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

test('共有 executor はゲートへ env を渡さない（env で開く経路を残さない）', () => {
  assert.equal(/canSharedExecutorSend\(fields,\s*process\.env\)/.test(execSrc), false,
    '共有 executor がゲートへ env を渡している');
  assert.match(execSrc, /canSharedExecutorSend\(fields\)/, 'ゲート呼び出しが fields のみでない');
});

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
