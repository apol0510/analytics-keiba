/**
 * marketingStatusScan.guard.test.mjs — 状態表示が「黙った打ち切り」に戻らないことの監視
 *   node --test src/lib/marketing/marketingStatusScan.guard.test.mjs
 *
 * ── 何を守るか ────────────────────────────────────────────────
 * `admin-marketing.js` の `fetchAll` は `MAX_PAGES`（4,000 行）で **break** する。
 * 例外にならないので、呼び出し側は短い結果を全体だと誤認する。
 *
 * 2026-08-15 の実測: `CampaignDeliveries` は **14,426 行**あり、4,000 行を超えた時点で
 * `handleSequence` / `handleJobs` / `handleHistory` が打ち切りに掛かり、
 * Step1 を 10 名ぶんキュー登録した直後に管理画面が
 * **「送信済み 1 名 / 残り 9 名」** と表示した（実際は 10 名とも queued）。
 *
 * よって `CampaignDeliveries` / `ScheduledEmails` を**打ち切る取得で読まない**ことを
 * ソース検査で固定する。読むなら名指し（`fetchDeliveriesByEmails` /
 * `fetchDeliveriesByJobIds`）か fail closed（`fetchAllStrict`）のどちらか。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FN = resolve(HERE, '../../../netlify/functions/admin-marketing.js');
const SRC = readFileSync(FN, 'utf8');

/** `fetchAll({ ... })` の呼び出しを本文ごと拾う（`fetchAllStrict` は別物として除外） */
function collectFetchAllCalls(src) {
  const out = [];
  const re = /(?<![A-Za-z])fetchAll\(\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // 対応する閉じ括弧まで（ネストは浅いので括弧数で足りる）
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

test('【重要】打ち切る fetchAll で CampaignDeliveries / ScheduledEmails を読まない', () => {
  const calls = collectFetchAllCalls(SRC);
  assert.ok(calls.length > 0, 'fetchAll の呼び出しを 1 件も拾えていない（検査が空振りしている）');
  const offenders = calls.filter((c) => /DELIVERIES_TABLE|SCHEDULED_TABLE|CampaignDeliveries|ScheduledEmails/.test(c));
  assert.deepEqual(offenders, [],
    `状態テーブルを打ち切る取得で読んでいる:\n${offenders.join('\n---\n')}`);
});

test('【重要】fetchAllStrict は打ち切りを例外にする（break で済ませない）', () => {
  const m = SRC.match(/async function fetchAllStrict\(\{[\s\S]*?\n\}/);
  assert.ok(m, 'fetchAllStrict が無い');
  const body = m[0];
  assert.match(body, /assertFetchComplete\(\{ table, offset, pages, maxPages \}\)/,
    '打ち切り時に例外を投げていない');
  assert.equal(/pages >= maxPages\) break/.test(body), false, '黙って break している');
});

test('【重要】状態表示の取得失敗を空配列へ潰さない（0 件と区別できなくなる）', () => {
  // `fetchAll...(...).catch(() => [])` の形が状態テーブルに残っていないこと
  const bad = SRC.match(/fetchAll(?:Strict)?\(\{[\s\S]{0,400}?\}\)\s*\n?\s*\.catch\(\(\) => \[\]\)/g) || [];
  const offenders = bad.filter((c) => /DELIVERIES_TABLE|SCHEDULED_TABLE/.test(c));
  assert.deepEqual(offenders, [], `失敗を 0 件に潰している:\n${offenders.join('\n---\n')}`);
});

/** コメント行を落とす（「昔はこうだった」という説明を実装として誤検知しないため） */
function stripComments(src) {
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

test('【重要】handleSequence は受信対象の宛先だけを名指しで引く', () => {
  const m = SRC.match(/async function handleSequence\(\{[\s\S]*?\n\}/);
  assert.ok(m, 'handleSequence が無い');
  const body = m[0];
  const code = stripComments(body);
  assert.match(code, /fetchDeliveriesByEmails\(\{/, '名指し取得を使っていない');
  assert.equal(/EmailType\}='campaign'/.test(code), false, '台帳を全件で読んでいる');
  assert.equal(/(?<![A-Za-z])fetchAll\(\{/.test(code), false, '打ち切る取得が残っている');
  assert.match(code, /deliveries_fetch_incomplete/, '取り切れなかったときに fail closed していない');
});

test('【重要】handleJobs はジョブを絞り、配信行を JobId で名指しする', () => {
  const m = SRC.match(/async function handleJobs\(\{[\s\S]*?\n\}/);
  assert.ok(m, 'handleJobs が無い');
  const body = m[0];
  assert.match(body, /MARKETING_JOB_FORMULA/, 'ScheduledEmails を全件で読んでいる');
  assert.match(body, /fetchDeliveriesByJobIds\(\{/, '配信行を名指しで引いていない');
  assert.match(body, /jobs_fetch_incomplete/, '取り切れなかったときに fail closed していない');
});

test('【重要】handleCancelJob は取得に失敗したら 1 バイトも書かない（部分取消の防止）', () => {
  const m = SRC.match(/async function handleCancelJob\(\{[\s\S]*?\n\}/);
  assert.ok(m, 'handleCancelJob が無い');
  const body = m[0];
  assert.match(body, /cancel_job_fetch_failed/);
  assert.match(body, /cancel_deliveries_fetch_incomplete/);
  // 取得エラーの return が最初の patchRecord より前にあること
  const firstPatch = body.indexOf('patchRecord(');
  const lastGuard = body.indexOf('cancel_deliveries_fetch_incomplete');
  assert.ok(lastGuard !== -1 && firstPatch !== -1 && lastGuard < firstPatch,
    '書き込みの後で取得失敗を判定している');
});

test('【重要】履歴の名指し取得は載せられない宛先を黙って飛ばさない', () => {
  const m = SRC.match(/async function fetchDeliveriesByEmails\(\{[\s\S]*?\n\}/);
  assert.ok(m, 'fetchDeliveriesByEmails が無い');
  assert.match(m[0], /safe\.length !== group\.length/, '飛ばした宛先を検知していない');
  assert.match(m[0], /throw new Error/, '飛ばしても続行している');
});

test('打ち切る fetchAll 自体には危険性が明記されている', () => {
  const idx = SRC.indexOf('async function fetchAll({');
  const before = SRC.slice(Math.max(0, idx - 700), idx);
  assert.match(before, /黙って打ち切る/, '危険性の注意書きが消えている');
});
