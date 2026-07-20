/**
 * paymentEmailDispatchSchedule.guard.test.mjs — B1 dispatcher / B2 reconciler schedule の
 * 「配線」を実ファイル検査で固定する。
 *
 * Netlify Scheduled Functions の本番仕様（公開 URL から呼べない / 30 秒上限）と D1 の安全境界
 * （A2 未停止・legacy では送信/書込み 0、gate fail-closed、HTTP 自己呼出しない、PII 非出力、
 * deadline guard / 件数上限）を実装の書き換えで崩さないよう grep で固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateEmailGates, parseGatesFromEnv } from './paymentEmailState.js';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const DISPATCH_FN = readFileSync(here('../../../netlify/functions/payment-email-dispatcher.js'), 'utf8');
const RECON_CRON = readFileSync(here('../../../netlify/functions/cron-payment-email-reconciler.js'), 'utf8');
const RECON_FN = readFileSync(here('../../../netlify/functions/payment-email-reconciler.js'), 'utf8');
const CORE = readFileSync(here('./paymentEmailDispatcher.js'), 'utf8');
const RECON_CORE = readFileSync(here('./paymentEmailReconciler.js'), 'utf8');

// ── Scheduled 配線 ─────────────────────────────────────────────
test('guard: dispatcher と reconciler cron が Scheduled 設定を持つ', () => {
  assert.ok(/export const config\s*=\s*\{[\s\S]*schedule:/.test(DISPATCH_FN), 'dispatcher に schedule 設定が無い');
  assert.ok(/export const config\s*=\s*\{[\s\S]*schedule:/.test(RECON_CRON), 'reconciler cron に schedule 設定が無い');
});

// ── 公開 URL 手動 POST を運用契約として残さない（Netlify 仕様: scheduled は URL 呼出不可）──
test('guard: dispatcher は Scheduled 専用（URL POST 認証分岐を持たない）', () => {
  assert.ok(!/x-worker-secret/i.test(DISPATCH_FN), 'dispatcher に URL POST 用の secret 認証が残っている');
  assert.ok(!/httpMethod|request\.method|event\.headers|req\.headers/.test(DISPATCH_FN),
    'dispatcher に HTTP メソッド/ヘッダ分岐（手動 POST 契約）が残っている');
  assert.ok(!/手動\s*POST/.test(DISPATCH_FN), 'コメントに「手動 POST」運用契約が残っている');
  assert.ok(/Run now/.test(DISPATCH_FN), '手動確認手順（Netlify UI Run now）が明記されていない');
});

test('guard: reconciler cron も Scheduled 専用（明示認証の手動経路は既存 Function へ分離）', () => {
  // cron は request/headers/secret を「使わない」こと（コメント中の言及は許容・実コードのみ検査）。
  assert.ok(!/request\.headers|event\.headers|WORKER_SECRET|providedSecret/.test(RECON_CRON),
    'cron が URL POST 用の secret/ヘッダを消費している');
  assert.ok(/exports\.handler/.test(RECON_FN), '既存 reconciler（手動認証 Function）が変わっている');
  assert.ok(/x-worker-secret|X-Worker-Secret/.test(RECON_FN), '既存 reconciler が secret 認証を失っている');
  assert.ok(!/export const config/.test(RECON_FN), '既存 reconciler に schedule を混ぜている（手動経路と分離されていない）');
});

// ── gate fail-closed ───────────────────────────────────────────
test('guard: dispatcher は v2-worker / v2-full 以外で送信を開始しない', () => {
  assert.ok(/validateEmailGates\(parseGatesFromEnv/.test(DISPATCH_FN), 'gate 判定を通していない');
  assert.ok(/mode !== 'v2-worker' && .*mode !== 'v2-full'/.test(DISPATCH_FN), '送信モード限定になっていない');
});

test('guard: reconciler cron は v2-full のときだけ書き込む（それ以外 dryRun）', () => {
  assert.ok(/dryRun = gate\.mode !== 'v2-full'/.test(RECON_CRON), 'v2-full 以外で書込みを許している');
});

// ── 30 秒上限: 件数上限 + deadline guard ───────────────────────
test('guard: dispatcher は件数上限と deadline を worker コアへ渡す', () => {
  assert.ok(/const MAX_RECORDS\s*=\s*\d+/.test(DISPATCH_FN), 'MAX_RECORDS が定数化されていない');
  const m = DISPATCH_FN.match(/const MAX_RECORDS\s*=\s*(\d+)/);
  assert.ok(Number(m[1]) <= 5, `dispatcher の件数上限が大きすぎる（30 秒制約）: ${m[1]}`);
  assert.ok(/deadlineAt:\s*now \+ DEADLINE_MS/.test(DISPATCH_FN), 'deadline を渡していない');
  assert.ok(/DEADLINE_MS\s*=\s*2[0-9]_?000/.test(DISPATCH_FN), 'deadline が 30 秒上限の安全マージンでない');
});

test('guard: dispatcher core は deadline 到達後に新規レコード処理を開始しない', () => {
  assert.ok(/pastDeadline\(\)/.test(CORE), 'deadline guard が無い');
  // deadline チェックがループ内・runOne 呼出より前にあること
  const loopBody = CORE.slice(CORE.indexOf('for (const rec of records)'));
  const iDeadline = loopBody.indexOf('pastDeadline()');
  const iRun = loopBody.indexOf('deps.runOne');
  assert.ok(iDeadline >= 0 && iDeadline < iRun, 'deadline チェックが runOne より後（時間切れ後も送ってしまう）');
});

test('guard: reconciler cron / core は件数上限と deadline を持つ', () => {
  assert.ok(/const RECON_MAX\s*=\s*\d+/.test(RECON_CRON), 'reconciler の件数上限が定数化されていない');
  assert.ok(/maxRecords: RECON_MAX/.test(RECON_CRON) && /deadlineAt:/.test(RECON_CRON), 'cron が上限/deadline を渡していない');
  assert.ok(/pastDeadline\(\)/.test(RECON_CORE), 'reconciler core に deadline guard が無い');
  assert.ok(/maxRecords[\s\S]*slice\(0, maxRecords\)/.test(RECON_CORE), 'reconciler core が件数制限していない');
});

// ── HTTP 自己呼出しない（同一プロセス実行）────────────────────────
test('guard: dispatcher は自分の worker Function を HTTP で呼ばない（core を直接実行）', () => {
  assert.ok(!/\.netlify\/functions\/payment-email-worker/.test(DISPATCH_FN + CORE), 'worker Function を HTTP 経由で呼んでいる');
  assert.ok(!/fetch\(/.test(CORE), 'dispatcher core が fetch を持っている（実 IO は deps 経由のはず）');
});

// ── dispatch ロック（重複起動防止）────────────────────────────
test('guard: dispatcher core は dispatch 単位ロックを取得・解放する', () => {
  assert.ok(/acquireLock\(DISPATCH_LOCK_KEY\)/.test(CORE), 'dispatch ロックを取得していない');
  assert.ok(/finally\s*\{[\s\S]*releaseLock/.test(CORE), 'ロックを finally で解放していない');
});

test('guard: reconciler cron は reconcile 単位ロックを取得・解放する', () => {
  assert.ok(/acquireLock\(RECONCILE_LOCK_KEY\)/.test(RECON_CRON), 'reconcile ロックを取得していない');
  assert.ok(/finally\s*\{[\s\S]*releaseLock/.test(RECON_CRON), 'ロックを finally で解放していない');
});

// ── PII 非出力 ─────────────────────────────────────────────────
test('guard: dispatcher core / Function のログに recordId / Email を出さない', () => {
  for (const [name, src] of [['core', CORE], ['dispatch-fn', DISPATCH_FN], ['recon-cron', RECON_CRON]]) {
    const logs = src.match(/(?:deps\.)?log\([\s\S]*?\)|console\.(log|error)\([\s\S]*?\)/g) || [];
    for (const l of logs) {
      assert.ok(!/recordId|record\.id|Email/.test(l), `${name} のログに識別子/PII: ${l.slice(0, 80)}`);
    }
  }
});

test('guard: reconciler cron は per-record id を応答へ返さない（集計のみ）', () => {
  assert.ok(!/results/.test(RECON_CRON), 'cron が per-record results を返している');
  assert.ok(/byAction/.test(RECON_CRON) && /count/.test(RECON_CRON), '集計のみを返していない');
});

// ── legacy / dry-run での実挙動（0 送信・0 書込み）──────────────
test('挙動: legacy gate は送信モードでも書込みモードでもない', () => {
  const legacy = validateEmailGates(parseGatesFromEnv({}));
  assert.equal(legacy.mode, 'legacy');
  assert.ok(legacy.mode !== 'v2-worker' && legacy.mode !== 'v2-full', 'legacy が送信モードになっている');
});

test('挙動: A2 未確認の v2 は invalid（送信モードに絶対ならない）', () => {
  const g = validateEmailGates({ flow: 'v2', workerSend: true, reconcilerWrite: false, globalPause: false, a2DisabledConfirmed: false });
  assert.equal(g.ok, false);
  assert.notEqual(g.mode, 'v2-worker');
  assert.notEqual(g.mode, 'v2-full');
});

test('挙動: GLOBAL_PAUSE=true は paused（送信も書込みもしない）', () => {
  const g = validateEmailGates({ flow: 'v2', workerSend: false, reconcilerWrite: false, globalPause: true, a2DisabledConfirmed: true });
  assert.equal(g.mode, 'paused');
});

test('挙動: v2-dry-run は reconciler 書込みモードではない', () => {
  const g = validateEmailGates({ flow: 'v2', workerSend: false, reconcilerWrite: false, globalPause: false, a2DisabledConfirmed: true });
  assert.equal(g.mode, 'v2-dry-run');
  assert.notEqual(g.mode, 'v2-full');
});
