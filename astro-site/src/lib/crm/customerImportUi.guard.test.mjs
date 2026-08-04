/**
 * customerImportUi.guard.test.mjs — 取り込み基盤で壊してはいけない境界を固定する
 *   node --test src/lib/crm/customerImportUi.guard.test.mjs
 *
 * ソース文字列を直接読む guard。**API と画面が約束から外れたら落ちる**。
 *
 * 守るもの:
 *   1. 下見 API は read-only（書き込みの綴りを持たない）
 *   2. 応答にアドレス・氏名・recordId を載せない
 *   3. 本番取り込みの実行経路がこの Function に存在しない
 *   4. 画面は 13,000 行を DOM へ描かない・個人データ一覧を出さない
 *   5. 本番取り込みボタンは disabled
 *   6. 既存の小規模フロー（顧客マーケ / カムバック / Premium Plus）を壊さない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const FN = read('../../../netlify/functions/admin-customer-import.js');
const PAGE = read('../../pages/admin/premium-plus-eligibility.astro');
const PARSE = read('./csvParse.js');
const PREVIEW = read('./importPreview.js');
const JOB = read('./importJobPlan.js');

/** コメントを除いた「実際に動くコード」だけを見る */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

/** 画面のうち取り込み**セクションの markup**（説明文を含む） */
const impSection = () => {
  const i = PAGE.indexOf('外部顧客リストの取り込み（下見）');
  assert.ok(i > -1, '取り込みセクションが無い');
  const end = PAGE.indexOf('</section>', i);
  return PAGE.slice(i, end > -1 ? end : i + 4000);
};

/**
 * 画面のうち取り込みの**動くコード**だけ。
 * 説明文（「氏名は出しません」等）を拾って誤検知しないよう markup と分ける。
 */
const impScript = () => {
  const i = PAGE.indexOf("const IMPORT_API = '/.netlify/functions/admin-customer-import'");
  assert.ok(i > -1, '取り込みの API 定義が無い');
  // 取り込みブロックの最後は「受け入れ仕様」ボタンの処理。その閉じ括弧までを対象にする
  const last = PAGE.indexOf("$('impSpec')?.addEventListener", i);
  assert.ok(last > i, '取り込みブロックの終端が見つからない');
  const end = PAGE.indexOf('\n    });', last);
  assert.ok(end > last, '取り込みブロックが閉じていない');
  return PAGE.slice(i, end + 8);
};

/** Function のうち下見成功時の応答 body */
const previewResponseBody = () => {
  const i = FN.indexOf('async function handlePreviewCsv');
  assert.ok(i > -1, 'handlePreviewCsv が無い');
  const fn = FN.slice(i);
  const r = fn.indexOf('return json(200, {');
  assert.ok(r > -1, '下見の応答が無い');
  // この return 文だけを見る（次の関数まで拾うと別の処理を誤検知する）
  const end = fn.indexOf('\n  });', r);
  assert.ok(end > r, '応答の終端が見つからない');
  return fn.slice(r, end);
};

// ── 1. 下見 API は read-only ──────────────────────────────────

test('guard(api): 下見 API は Airtable へ書き込まない', () => {
  const code = codeOnly(FN);
  for (const w of ['method: \'PATCH\'', 'method: "PATCH"', 'method: \'POST\', body: JSON.stringify({ fields',
    'createRecord', 'patchRecord', 'upsert', 'performUpsert', 'typecast']) {
    assert.equal(code.includes(w), false, `書き込み系 ${w} を持っている`);
  }
  // 書き込みを行う HTTP メソッドの綴りが（fetch 呼び出しとして）存在しない
  assert.equal(/method:\s*['"](PATCH|PUT|DELETE)['"]/.test(code), false, '更新系メソッドを組み立てている');
});

test('guard(api): 下見 API はメールを送らない', () => {
  const code = codeOnly(FN);
  assert.equal(code.includes('mail/send'), false, '送信エンドポイントを組み立てている');
  assert.equal(code.includes('@sendgrid/mail'), false);
  // 読んでよいのは suppression（停止リスト）だけ
  assert.match(FN, /fetchProviderSuppression/, '停止リストの確認をしていない');
});

test('guard(api): 副作用なしと明示する', () => {
  assert.match(FN, /sideEffects: 'none'/);
  assert.match(FN, /まだ取り込まれていません/);
});

// ── 2. 応答に個人情報を載せない ────────────────────────────────

test('guard(api): 応答にアドレス・氏名・recordId を含めない', () => {
  const body = previewResponseBody();
  for (const bad of ['RecipientEmail', 'rows:', 'emails:', 'recordId', 'records:', '氏名', 'sample']) {
    assert.equal(body.includes(bad), false, `応答に ${bad} を載せている`);
  }
  // 返してよいのは件数・ハッシュ・列名
  for (const good of ['counts', 'classificationCounts', 'reasonCounts', 'preview']) {
    assert.ok(body.includes(good), `${good} を返していない`);
  }
});

test('guard(api): 例外の中身をそのまま返さない（CSV の値が混ざる）', () => {
  const catchBlock = FN.slice(FN.indexOf('} catch (e) {'));
  assert.equal(/e\.message/.test(catchBlock), false, '例外メッセージを外へ出している');
  assert.match(catchBlock, /internal error/);
});

test('guard(lib): 判定・下見・実行モデルは console を使わない', () => {
  for (const [name, src] of [['csvParse', PARSE], ['importPreview', PREVIEW], ['importJobPlan', JOB]]) {
    assert.equal(/console\./.test(codeOnly(src)), false, `${name} が console を使っている`);
  }
});

test('guard(lib): 下見の記録に行の中身を持たせない', () => {
  const i = PREVIEW.indexOf('export function buildPreviewRecord');
  const fn = PREVIEW.slice(i, i + 2000);
  for (const bad of ['email', 'name:', 'rows']) {
    assert.equal(fn.includes(bad), false, `下見の記録に ${bad} を入れている`);
  }
  assert.match(fn, /fileHash/);
  assert.match(fn, /summaryHash/);
});

// ── 3. 本番取り込みの実行経路が無い ────────────────────────────

test('guard(api): 取り込みの実行は未実装（501 で断る）', () => {
  assert.match(FN, /action === 'run'/, '実行 action の受け口が無い（未知 action として 400 になる想定なら本 guard を更新）');
  assert.match(FN, /501/, '実行要求を 501 で断っていない');
  assert.match(FN, /別 Phase・別承認/);
});

test('guard(gate): 書き込みゲートは既定 OFF', () => {
  assert.match(JOB, /CUSTOMER_IMPORT_WRITE_ENABLED === 'true'/, 'ゲートの綴りが違う');
  assert.equal(/CUSTOMER_IMPORT_WRITE_ENABLED\s*!==\s*'false'/.test(JOB), false, '既定 ON になっている');
});

test('guard(job): 計画より多く書けない・二重書き込みを防ぐ', () => {
  assert.match(JOB, /write_limit_reached/);
  assert.match(JOB, /already_written/);
  assert.match(JOB, /batch_already_running/);
});

// ── 4-5. 画面 ─────────────────────────────────────────────────

test('guard(ui): 取り込み結果を明細で描画しない', () => {
  const s = impScript();
  // 行ごとの明細を作るループを持たない（件数表の行は固定ラベル）
  assert.equal(/for \(const (r|row|c) of (out|data)\.(rows|records|customers|emails)/.test(s), false,
    '取り込み結果から明細を描画している');
  assert.equal(s.includes('out.rows'), false, '行データを画面で読んでいる');
  assert.equal(s.includes('data.rows'), false);
  // 描くのは件数（counts）と理由（reasonCounts）だけ
  assert.match(s, /out\.counts/);
  assert.match(s, /out\.reasonCounts/);
});

test('guard(ui): 画面へアドレス・氏名を出さない（動くコードで検査）', () => {
  const s = impScript();
  for (const bad of ['RecipientEmail', '.email', '氏名', 'recordId', '.name']) {
    assert.equal(s.includes(bad), false, `画面のコードが ${bad} を読んでいる`);
  }
  // ファイルの中身は base64 のまま API へ渡すだけ（画面で本文を組み立てない）
  assert.match(s, /contentBase64/);
  assert.equal(/readAsText\(/.test(s), false, 'CSV をテキストとして画面へ読み込んでいる');
});

test('guard(ui): 「まだ取り込まれていません」を必ず出す', () => {
  const s = impSection();
  assert.match(s, /まだ取り込まれていません/);
  assert.match(FN, /まだ取り込まれていません/, 'API 側の明示が無い');
});

test('guard(ui): 本番取り込みボタンは disabled のまま', () => {
  const s = impSection();
  const i = s.indexOf('id="impRun"');
  assert.ok(i > -1, '本番取り込みボタンが無い');
  const btn = s.slice(i - 200, i + 300);
  assert.match(btn, /disabled/, 'ボタンが押せる状態になっている');
  assert.match(btn, /aria-disabled="true"/);
  assert.match(s, /別承認/, '別承認が必要だと書いていない');
  // クリックで実行する配線を持たない
  assert.equal(/impRun'\)\?\.addEventListener/.test(PAGE), false, '実行ボタンに処理を配線している');
});

test('guard(ui): 下見は件数だけを表示する', () => {
  const s = impSection();
  assert.match(s, /件数と除外理由/);
  assert.match(s, /画面にも通信にも出しません/);
});

// ── 6. 既存フローの非回帰 ─────────────────────────────────────

test('guard(regression): 既存の小規模フローを壊していない', () => {
  for (const marker of [
    'mkSelAll', 'mkDryRun', "action: 'dryRun'", "action: 'send'",
    'cbSelAll', 'cbDryRun', 'mkHandoffRestore', 'mkRecoverBtn',
    'mkSegLoad', 'mkRenderMeasurement',
  ]) {
    assert.ok(PAGE.includes(marker), `${marker} が消えている（既存フローの回帰）`);
  }
});

test('guard(regression): 取り込みは既存 API を経由しない（別 Function に分ける）', () => {
  const s = impSection();
  assert.equal(s.includes('/.netlify/functions/admin-marketing'), false,
    '取り込みを送信系 API に相乗りさせている');
  assert.match(PAGE, /const IMPORT_API = '\/\.netlify\/functions\/admin-customer-import'/);
});
