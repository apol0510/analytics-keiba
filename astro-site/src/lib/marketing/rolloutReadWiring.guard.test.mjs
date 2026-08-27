/**
 * rolloutReadWiring.guard.test.mjs — **配線が戻らない**ことを固定する（静的検査）
 *
 *   node --test src/lib/marketing/rolloutReadWiring.guard.test.mjs
 *
 * 動きのテスト（`rolloutApiBudget` / `rolloutJourney.integration`）は
 * 「いまの配線で安いこと」を見る。ここは**配線そのもの**を見る。
 * 「気づかないうちに元の重い経路へ戻す」変更を、レビュー前に落とす。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROLLOUT = readFileSync(new URL('../../../netlify/functions/cron-marketing-rollout.js', import.meta.url), 'utf8');
const ADMIN = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');

/** コメントを外した本文（説明文の中の文字列に反応しないように） */
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const ROLLOUT_CODE = codeOnly(ROLLOUT);
const ADMIN_CODE = codeOnly(ADMIN);

test('【配線】tick は事実を読む前に排他鍵を取る（重なった実行が台帳を読まない）', () => {
  const lockAt = ROLLOUT_CODE.indexOf('lock.acquire(');
  const runAt = ROLLOUT_CODE.indexOf('runRolloutTick({ env: process.env');
  assert.ok(lockAt > 0, '排他鍵の取得が見当たらない');
  assert.ok(runAt > 0, 'tick の呼び出しが見当たらない');
  assert.ok(
    lockAt < runAt,
    '排他鍵より先に tick を走らせている（重なった実行が Airtable を読んでしまう）',
  );
});

test('【配線】自動運転のジョブ照会は軽い版（jobsBrief）を使う', () => {
  assert.match(ROLLOUT_CODE, /action: 'jobsBrief'/,
    '画面用の action=jobs へ戻ると、tick ごとに配信台帳を 30〜40 回読む');
  assert.doesNotMatch(ROLLOUT_CODE, /action: 'jobs'\s*[,}]/,
    'cron から画面用の action=jobs を呼んでいる');
});

test('【配線】jobsBrief は CampaignDeliveries を読まない', () => {
  const start = ADMIN_CODE.indexOf('async function handleJobsBrief');
  assert.ok(start > 0, 'handleJobsBrief が見当たらない');
  // 次の関数宣言までを本体とみなす
  const rest = ADMIN_CODE.slice(start + 10);
  const end = rest.indexOf('\nasync function ');
  const body = end > 0 ? rest.slice(0, end) : rest;
  assert.doesNotMatch(body, /DELIVERIES_TABLE/,
    'jobsBrief が配信台帳を読んでいる（軽い版の意味が無くなる）');
  assert.match(body, /SCHEDULED_TABLE/, 'ScheduledEmails を読んでいない');
});

test('【配線】重い事実収集は条件付きで呼ばれる（無条件 await へ戻さない）', () => {
  assert.match(ROLLOUT_CODE, /wantGrantPlan\s*\n?\s*\?\s*await loadAndPlanLightTrial\(/,
    '付与計画を無条件で読んでいる');
  assert.match(ROLLOUT_CODE, /wantSequence \? await readNextDueStep\(\)/,
    '進行読み（最重量）を無条件で読んでいる');
  assert.match(ROLLOUT_CODE, /needsGrantPlan\(/);
  assert.match(ROLLOUT_CODE, /needsSequenceRead\(/);
  assert.match(ROLLOUT_CODE, /planTickReads\(/);
});

test('【配線】cron の間隔を 2 分より短くしない（払う API 回数に直に比例する）', () => {
  const m = /schedule: '(\*\/(\d+)) \* \* \* \*'/.exec(ROLLOUT);
  assert.ok(m, 'schedule の宣言が読めない');
  const minutes = Number(m[2]);
  assert.ok(
    minutes >= 5,
    `間隔が ${minutes} 分になっている。速さの上限は関所であって cron の間隔ではない`
    + '（2026-08 に 2 分間隔で月 8,372,540 回まで膨らんだ）',
  );
});

test('【配線】進行読みの据え置きは、積んだ tick で必ず解かれる', () => {
  assert.match(ROLLOUT_CODE, /saveStateAfterAction = \(next\) => saveState\(clearSequenceDefer\(next\)\)/,
    '据え置きを解かずに書き戻すと「積んだのに次が来ない」時間が伸びる');
  /**
   * 素の `saveState({...})` を直接呼んでよいのは **1 か所だけ**
   * （SKIP の tick が据え置きを**張る**ための書き戻し）。
   * 行動した tick は必ず `saveStateAfterAction` を通す。
   */
  const raw = (ROLLOUT_CODE.match(/await saveState\(\{/g) || []).length;
  assert.equal(raw, 1,
    `素の saveState が ${raw} か所ある。行動した tick は saveStateAfterAction を通すこと`);
  const wrapped = (ROLLOUT_CODE.match(/await saveStateAfterAction\(\{/g) || []).length;
  assert.ok(wrapped >= 5, `行動した tick の書き戻しが少なすぎる（${wrapped} か所）`);
});
