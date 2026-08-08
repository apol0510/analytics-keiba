/**
 * automationTickLog.test.mjs — cron の早期 return を**ログから区別できる**ことの固定
 *   node --test src/lib/marketing/automationTickLog.test.mjs
 *
 * 事故（2026-08-07）:
 *   `cron-marketing-automation` の初回スケジュール起動（JST 10:00）は確認できたが、
 *   早期 return の 2 経路がどちらもログを出さないため、Netlify のログには
 *   `Duration:` 行しか残らなかった。その結果、
 *
 *     - 200 `gates_closed`        … 仕組みは正常。env を開ければ動く
 *     - 404 `not_scheduled_payload` … fail-closed で安全だが、env を開けても永久に動かない
 *
 *   を**外形から区別できず**、runbook の合格条件が検証不能だった。
 *
 * 恒久的な回帰条件:
 *   1. 2 経路がそれぞれ 1 行ずつログを出し、`reason` で区別できる
 *   2. ログに **env の値** を 1 つも載せない（出すのは判定結果と未設定 env の**名前**だけ）
 *   3. 404 経路は**設定状況を載せない**（呼び出し元にも server ログにも設定を書かない方針を維持）
 *   4. レスポンス本文は従来と一字も変えない（ログ追加は観測性だけの変更）
 *   5. ログ出力が失敗しても処理を止めない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  runScheduledTick,
  readGates,
  ARMED_ENV,
  TICK_LOG_TAG,
} from '../../../netlify/functions/cron-marketing-automation.js';

const NOW = Date.parse('2026-08-07T01:00:00.000Z'); // JST 10:00（cron の発火時刻）
const SCHEDULED = { next_run: '2026-08-08T01:00:00.000Z' };

/**
 * ログを捕まえるスパイ。
 * 本番は `console.log(line)` を**直接**呼ぶ（detach 禁止）ので、受け取るのは 1 本の文字列。
 */
function spy() {
  const lines = [];
  return { lines, log: (...args) => lines.push(args) };
}
/** `'[marketing-automation] {json}'` を tag と body に割る。 */
const parsed = (lines) => lines.map((args) => {
  assert.equal(args.length, 1, 'ログは 1 引数の文字列で出す（複数引数にしない）');
  const line = String(args[0]);
  const i = line.indexOf(' ');
  return { tag: line.slice(0, i), body: JSON.parse(line.slice(i + 1)) };
});

/** 全ゲートが閉じた env（production の現状と同じ形）。 */
const CLOSED_ENV = {};
/** 全ゲートが開いた env。 */
const openEnv = (nowMs) => ({
  MARKETING_AUTOMATION_SCHEDULER_ENABLED: 'true',
  MARKETING_CAMPAIGN_ENABLED: 'true',
  MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
  [ARMED_ENV]: readGates({}, nowMs).today,
});

// ── 1. 2 経路を reason で区別できる ────────────────────────────
test('gates_closed: ログを 1 行出し reason で区別できる', async () => {
  const s = spy();
  const r = await runScheduledTick({ payload: SCHEDULED, now: NOW, env: CLOSED_ENV, log: s.log });
  assert.equal(r.statusCode, 200);
  assert.equal(s.lines.length, 1, 'ログが 1 行ではない');
  const [{ tag, body }] = parsed(s.lines);
  assert.equal(tag, TICK_LOG_TAG);
  assert.equal(body.reason, 'gates_closed');
  assert.equal(body.ran, false);
  assert.equal(body.sideEffects, 'none');
  assert.deepEqual(body['接続'], { redis: false, airtable: false });
});

test('not_scheduled_payload: ログを 1 行出し reason で区別できる', async () => {
  for (const payload of [null, undefined, {}, { foo: 1 }, { next_run: '' }, { next_run: 1 },
    { next_run: 'x', httpMethod: 'POST' }, 'not json']) {
    const s = spy();
    const r = await runScheduledTick({ payload, now: NOW, env: CLOSED_ENV, log: s.log });
    assert.equal(r.statusCode, 404, `payload=${JSON.stringify(payload)}`);
    assert.equal(s.lines.length, 1);
    const [{ body }] = parsed(s.lines);
    assert.equal(body.reason, 'not_scheduled_payload');
    assert.equal(body.ran, false);
    assert.equal(body.sideEffects, 'none');
  }
});

test('2 経路の reason は必ず異なる（区別できることが本質）', async () => {
  const a = spy(); await runScheduledTick({ payload: SCHEDULED, now: NOW, env: CLOSED_ENV, log: a.log });
  const b = spy(); await runScheduledTick({ payload: null, now: NOW, env: CLOSED_ENV, log: b.log });
  assert.notEqual(parsed(a.lines)[0].body.reason, parsed(b.lines)[0].body.reason);
});

// ── 2. env の値を載せない ──────────────────────────────────────
test('ログに env の値を 1 つも載せない（出すのは未設定 env の名前だけ）', async () => {
  const SECRETISH = 'SHOULD-NEVER-APPEAR-IN-LOGS';
  const env = {
    MARKETING_AUTOMATION_SCHEDULER_ENABLED: SECRETISH,
    MARKETING_CAMPAIGN_ENABLED: SECRETISH,
    MARKETING_CAMPAIGN_DISPATCH_ENABLED: SECRETISH,
    [ARMED_ENV]: SECRETISH,
    UPSTASH_REDIS_REST_TOKEN: SECRETISH,
    AIRTABLE_API_KEY: SECRETISH,
    SENDGRID_API_KEY: SECRETISH,
  };
  const s = spy();
  await runScheduledTick({ payload: SCHEDULED, now: NOW, env, log: s.log });
  const raw = JSON.stringify(s.lines);
  assert.ok(!raw.includes(SECRETISH), 'env の値がログに出ている');
  // 未設定 env の「名前」は出てよい（運用に必要）
  const [{ body }] = parsed(s.lines);
  assert.ok(Array.isArray(body['未設定のゲート']));
  assert.ok(body['未設定のゲート'].includes('MARKETING_CAMPAIGN_ENABLED'));
});

test('ログに載る未設定ゲートは readGates の結果と一致する', async () => {
  const s = spy();
  await runScheduledTick({ payload: SCHEDULED, now: NOW, env: CLOSED_ENV, log: s.log });
  const [{ body }] = parsed(s.lines);
  assert.deepEqual(body['未設定のゲート'], readGates(CLOSED_ENV, NOW).missing);
  // 4 ゲートすべてが閉じている前提の確認
  assert.equal(body['未設定のゲート'].length, 4);
});

// ── 3. 404 経路は設定状況を載せない ───────────────────────────
test('404 経路のログはゲートの設定状況を書かない', async () => {
  const s = spy();
  await runScheduledTick({ payload: null, now: NOW, env: openEnv(NOW), log: s.log });
  const [{ body }] = parsed(s.lines);
  assert.equal(body['未設定のゲート'], undefined, '設定状況を書いている');
  assert.equal(JSON.stringify(s.lines).includes('MARKETING_'), false, 'env 名を書いている');
});

test('404 経路はゲートが開いていても 404 のまま（ログ追加で挙動を変えない）', async () => {
  const r = await runScheduledTick({ payload: null, now: NOW, env: openEnv(NOW), log: () => {} });
  assert.equal(r.statusCode, 404);
  assert.deepEqual(r.body, { error: 'Not Found' });
});

// ── 4. レスポンス本文を変えていない ───────────────────────────
test('gates_closed のレスポンス本文は従来どおり', async () => {
  const r = await runScheduledTick({ payload: SCHEDULED, now: NOW, env: CLOSED_ENV, log: () => {} });
  assert.deepEqual(r.body, {
    mode: 'marketing-automation-scheduler',
    ran: false,
    reason: 'gates_closed',
    '未設定のゲート': readGates(CLOSED_ENV, NOW).missing,
    '接続': { redis: false, airtable: false },
    sideEffects: 'none',
    notice: 'ゲートが閉じているため何もしていません（Redis / Airtable へ接続していません）。',
  });
});

test('log 未指定でも例外にならない（本番は console.log に落ちる）', async () => {
  const r = await runScheduledTick({ payload: SCHEDULED, now: NOW, env: CLOSED_ENV });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.reason, 'gates_closed');
});

// ── 5. ログ失敗で処理を止めない ───────────────────────────────
test('ログ出力が投げても処理は続く', async () => {
  const boom = () => { throw new Error('log sink down'); };
  const a = await runScheduledTick({ payload: SCHEDULED, now: NOW, env: CLOSED_ENV, log: boom });
  assert.equal(a.statusCode, 200);
  assert.equal(a.body.reason, 'gates_closed');
  const b = await runScheduledTick({ payload: null, now: NOW, env: CLOSED_ENV, log: boom });
  assert.equal(b.statusCode, 404);
});

// ── 6. source guard ───────────────────────────────────────────
test('早期 return の 2 経路は必ずログを出す（無言に戻さない）', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../netlify/functions/cron-marketing-automation.js', import.meta.url)), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 404 経路
  const i404 = code.indexOf('if (!isScheduledPayload(payload))');
  const seg404 = code.slice(i404, code.indexOf('statusCode: 404', i404));
  assert.match(seg404, /logTick\(/, '404 経路が無言に戻っている');
  // gates_closed 経路
  const iGate = code.indexOf('if (!gates.allOpen)');
  const segGate = code.slice(iGate, code.indexOf('return { statusCode: 200, body };', iGate));
  assert.match(segGate, /logTick\(/, 'gates_closed 経路が無言に戻っている');
  // ゲート判定より前に Redis / Airtable を組み立てない構造は不変
  assert.ok(code.indexOf('createAutomationStore(') > iGate, 'store がゲートより前で組み立てられている');
});

test('ログに env オブジェクトを丸ごと渡していない', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../netlify/functions/cron-marketing-automation.js', import.meta.url)), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /logTick\([^)]*\bENV\b/, 'env を丸ごとログへ渡している');
  assert.doesNotMatch(code, /logTick\([^)]*process\.env/, 'process.env をログへ渡している');
});

test('ログの目印は安定している（検索の入口）', () => {
  assert.equal(TICK_LOG_TAG, '[marketing-automation]');
});

// ── 7. 空ログ退行の再発防止（2026-08-08）──────────────────────
//
// 2026-08-08 01:00:52Z の本番起動で message='' となり、変更前は出ていたランタイムの
// `Duration:` 行まで消えた。原因は `console.log` を detach して呼んでいたこと
// （Netlify Lambda は console を差し替えているためレシーバを失う）。
test('console.log を detach して呼ばない（空ログ退行の再発防止）', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../netlify/functions/cron-marketing-automation.js', import.meta.url)), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // `(... ? ... : console.log)(...)` / `const f = console.log` の形を禁止
  assert.doesNotMatch(code, /\?[^\n]*console\.log\s*\)\s*\(/, 'console.log を detach して呼んでいる');
  assert.doesNotMatch(code, /=\s*console\.log\s*[;,\n]/, 'console.log を変数へ代入している');
  // 直接呼び出しであること
  assert.match(code, /else console\.log\(line\);/, 'console.log を直接呼んでいない');
});

test('ログは 1 行 1 レコード（引数 1 本の文字列に畳む）', async () => {
  const s = spy();
  await runScheduledTick({ payload: SCHEDULED, now: NOW, env: CLOSED_ENV, log: s.log });
  assert.equal(s.lines.length, 1);
  assert.equal(s.lines[0].length, 1, '複数引数で出している');
  const line = String(s.lines[0][0]);
  assert.ok(line.startsWith(TICK_LOG_TAG + ' '), '目印が行頭に無い');
  assert.equal(line.includes('\n'), false, '1 レコードが複数行になっている');
  assert.doesNotThrow(() => JSON.parse(line.slice(TICK_LOG_TAG.length + 1)), '本体が JSON でない');
});
