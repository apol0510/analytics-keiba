/**
 * paymentEmailDispatchSchedule.guard.test.mjs — B1 dispatcher / B2 reconciler schedule の
 * 「配線」を実ファイル検査で固定する。
 *
 * D1 cutover の安全境界（A2 未停止・legacy では送信/書込み 0、gate fail-closed、HTTP 自己呼出しない、
 * PII 非出力、Scheduled 配線）が実装の書き換えで崩れないよう grep で固定する。
 * 加えて gate ロジック（validateEmailGates）で「legacy / dry-run では送信も書込みもしない」を実挙動で検証。
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

// ── Scheduled 配線 ─────────────────────────────────────────────
test('guard: dispatcher と reconciler cron が Scheduled 設定を持つ', () => {
  assert.ok(/export const config\s*=\s*\{[\s\S]*schedule:/.test(DISPATCH_FN), 'dispatcher に schedule 設定が無い');
  assert.ok(/export const config\s*=\s*\{[\s\S]*schedule:/.test(RECON_CRON), 'reconciler cron に schedule 設定が無い');
});

test('guard: 既存 reconciler の手動 POST 経路は壊さない（別ファイルで Scheduled 化）', () => {
  assert.ok(/exports\.handler/.test(RECON_FN), '既存 reconciler の handler が変わっている');
  assert.ok(!/export const config/.test(RECON_FN), '既存 reconciler に schedule を混ぜている（手動経路と分離されていない）');
  assert.ok(/payment-email-reconciler\.js/.test(RECON_CRON) || /reconcileUnknownBatch/.test(RECON_CRON),
    'cron が reconciler コアを使っていない');
});

// ── gate fail-closed ───────────────────────────────────────────
test('guard: dispatcher は v2-worker / v2-full 以外で送信を開始しない', () => {
  assert.ok(/validateEmailGates\(parseGatesFromEnv/.test(DISPATCH_FN), 'gate 判定を通していない');
  assert.ok(/mode !== 'v2-worker' && .*mode !== 'v2-full'/.test(DISPATCH_FN), '送信モード限定になっていない');
});

test('guard: reconciler cron は v2-full のときだけ書き込む（それ以外 dryRun）', () => {
  assert.ok(/dryRun = gate\.mode !== 'v2-full'/.test(RECON_CRON), 'v2-full 以外で書込みを許している');
});

// ── HTTP 自己呼出しない（同一プロセス実行）────────────────────────
test('guard: dispatcher は自分の worker Function を HTTP で呼ばない（core を直接実行）', () => {
  assert.ok(!/\.netlify\/functions\/payment-email-worker/.test(DISPATCH_FN + CORE),
    'worker Function を HTTP 経由で呼んでいる');
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
      assert.ok(!/recordId|\.id\b|record\.id|Email/.test(l), `${name} のログに識別子/PII: ${l.slice(0, 80)}`);
    }
  }
});

test('guard: reconciler cron / core は per-record id を応答へ返さない', () => {
  assert.ok(!/results/.test(RECON_CRON), 'cron が per-record results を返している');
  assert.ok(/count, byAction/.test(RECON_CRON), '集計のみを返していない');
});

// ── legacy / dry-run での実挙動（0 送信・0 書込み）──────────────
test('挙動: legacy gate は送信モードでも書込みモードでもない', () => {
  const legacy = validateEmailGates(parseGatesFromEnv({})); // 全 env 未設定 = legacy
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
