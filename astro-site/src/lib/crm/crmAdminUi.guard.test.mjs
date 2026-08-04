/**
 * crmAdminUi.guard.test.mjs — 大規模 CRM 化で壊してはいけない境界を固定する
 *   node --test src/lib/crm/crmAdminUi.guard.test.mjs
 *
 * ソース文字列を直接読む guard。**画面と API の実装が約束から外れたら落ちる**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = readFileSync(
  fileURLToPath(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url)), 'utf8');
const FN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url)), 'utf8');
const SEG = readFileSync(fileURLToPath(new URL('./audienceSegments.js', import.meta.url)), 'utf8');

const sliceFrom = (src, marker, len) => {
  const i = src.indexOf(marker);
  return i === -1 ? '' : src.slice(i, i + len);
};

// ── API: 個人情報を返さない ────────────────────────────────────

test('guard(api): セグメント API は read-only で副作用なしと明示する', () => {
  const fn = sliceFrom(FN, 'async function handleSegments(', 4000);
  assert.ok(fn, 'handleSegments が無い');
  assert.match(fn, /sideEffects: 'none'/, '副作用なしを明示していない');
  // 書き込み系を呼ばない
  for (const w of ['patchRecord', 'createRecord', 'upsert', 'sendgrid.com/v3/mail']) {
    assert.equal(fn.toLowerCase().includes(w.toLowerCase()), false, `${w} を呼んでいる`);
  }
});

test('guard(api): セグメント API の応答に個人情報・recordId を含めない', () => {
  const fn = sliceFrom(FN, 'async function handleSegments(', 4000);
  const body = fn.slice(fn.indexOf('return json(200'));
  for (const b of ['recordId', 'RecipientEmail', '氏名', 'rows:', 'customers:']) {
    assert.equal(body.includes(b), false, `応答に ${b} を含めている`);
  }
  // 返すのは件数と条件だけ
  for (const k of ['total', 'sendable', 'excluded', 'byReason', 'conditionHash']) {
    assert.ok(body.includes(k), `${k} を返していない`);
  }
});

test('guard(api): 未知のセグメントは 400 で止める', () => {
  const fn = sliceFrom(FN, 'async function handleSegments(', 4000);
  assert.match(fn, /SEGMENT_IDS\.includes\(wanted\)/, '許可値の検証が無い');
  assert.match(fn, /return json\(400/, '未知の条件を弾いていない');
});

test('guard(api): 画面から recordId 一覧を受け取らない', () => {
  const fn = sliceFrom(FN, 'async function handleSegments(', 4000);
  assert.equal(/req\.recordIds/.test(fn), false, 'クライアントの recordId を正本にしている');
  assert.match(fn, /req\.segmentId/, '条件を受け取っていない');
});

test('guard(api): 検証用サンプルは上限つき', () => {
  const fn = sliceFrom(FN, 'async function handleSegments(', 4000);
  assert.match(fn, /Math\.min\(req\.sampleSize, 20\)/, 'サンプル件数に上限が無い');
});

// ── 判定モジュール: fail closed ────────────────────────────────

test('guard(segment): 停止リストを確認できないときは全員除外', () => {
  assert.match(SEG, /provider === null.*\n?.*PROVIDER_UNKNOWN/s, 'fail closed になっていない');
});

test('guard(segment): 母数と内訳の一致を自分で検算する', () => {
  assert.match(SEG, /balanced: total === sendable \+ excluded/, '検算していない');
});

test('guard(segment): サンプルにアドレス・氏名・recordId を入れない', () => {
  const push = sliceFrom(SEG, 'sample.push({', 400);
  for (const b of ['Email', 'email:', '氏名', 'recordId']) {
    assert.equal(push.includes(b), false, `サンプルに ${b} を入れている`);
  }
});

// ── 画面: 13,000 件を描画しない ────────────────────────────────

test('guard(ui): セグメント下見は件数だけを描く（明細ループが無い）', () => {
  const fnStart = PAGE.indexOf('function mkRenderSegment(');
  assert.ok(fnStart > -1, 'mkRenderSegment が無い');
  const fn = PAGE.slice(fnStart, fnStart + 2600);
  // 顧客 1 件ずつの行を作るループを持たない
  assert.equal(/for \(const (r|row|c) of (seg|out)\.(rows|customers|list)/.test(fn), false,
    'セグメント結果から明細を描画している');
  assert.equal(fn.includes('createElement(\'tr\')'), false, '表の行を作っている');
  // サンプルは属性だけを 1 行にまとめて出す
  assert.match(fn, /seg\.sample/, 'サンプルを使っていない');
});

test('guard(ui): セグメント下見は個別選択と分けて置く', () => {
  assert.ok(PAGE.includes('seg-step'), 'セグメント下見のセクションが無い');
  assert.match(PAGE, /セグメントの下見（大規模）/);
  assert.match(PAGE, /対象顧客を絞り込む（個別に選ぶ）/, '個別選択側の見出しを分けていない');
});

test('guard(ui): 「まだ送信対象は固定されていません」と必ず言う', () => {
  assert.match(PAGE, /まだ送信対象は固定されていません/);
  const fn = sliceFrom(FN, 'async function handleSegments(', 4000);
  assert.match(fn, /まだ送信対象は固定されていません/, 'API 側の notice が無い');
});

test('guard(ui): 大規模送信のボタンをまだ置かない', () => {
  // 「セグメントへ一括送信」相当の実行ボタンが存在しないこと
  for (const b of ['mkSegSend', 'mkSegEnqueue', 'セグメントへ送信', 'セグメント一括送信']) {
    assert.equal(PAGE.includes(b), false, `${b} が既に存在する（本番送信機能は未実装であるべき）`);
  }
});

// ── 画面: 計測状態 ─────────────────────────────────────────────

test('guard(ui): 開封 0 と計測無効を区別して表示する', () => {
  assert.ok(PAGE.includes('mkRenderMeasurement'), '計測状態の表示が無い');
  assert.match(PAGE, /計測していない指標は「0」ではなく「—」と表示します/);
  assert.match(PAGE, /開封の計測: /);
  assert.match(PAGE, /クリックの計測: /);
});

test('guard(ui): provider 側だけの数値は参考値と断る', () => {
  assert.match(PAGE, /配信基盤側だけで確認できた数値は「参考値」/);
});

// ── 既存フローの非回帰 ─────────────────────────────────────────

test('guard(regression): 既存の小規模フローを壊していない', () => {
  for (const marker of [
    'mkSelAll', 'mkDryRun',                 // 既存の顧客選択・dry-run
    "action: 'dryRun'", "action: 'send'",   // 既存の送信経路
    'cbSelAll', 'cbDryRun',                 // カムバック特典
    'mkHandoffRestore', 'cbPruneSelectionForOffer',
    'mkRecoverBtn',                          // 引き継ぎの自動化・復旧
  ]) {
    assert.ok(PAGE.includes(marker), `${marker} が消えている（既存フローの回帰）`);
  }
});

test('guard(regression): 既存 action を消していない', () => {
  for (const a of ['customers', 'dryRun', 'send', 'jobs', 'cancelJob', 'history']) {
    assert.ok(FN.includes(`action === '${a}'`), `action '${a}' が消えている`);
  }
});

test('guard(regression): 引き継ぎ中は recordId を送らない（従来どおり）', () => {
  assert.match(PAGE, /\? \{ grantOperationId: mkState\.handoff\.operationId \}/);
});
