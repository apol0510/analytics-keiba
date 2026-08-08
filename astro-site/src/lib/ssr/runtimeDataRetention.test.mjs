/**
 * runtimeDataRetention.test.mjs — SSR 実行時データの保持ポリシー
 *   node --test src/lib/ssr/runtimeDataRetention.test.mjs
 *
 * 守りたい事故（2026-08-08）:
 *   有料ページを SSR 化した結果、ビルド時に読んでいた `src/data` を**実行時**に読むように
 *   なったのに、prune がサブツリーを**丸ごと削除**していた。認可を通った有料会員に
 *   「本日の予想データがありません」が出る（500 にならないので外形監視で気づけない）。
 *
 * 恒久的な回帰条件:
 *   1. 実行時に読むサブツリーを「全削除」対象へ入れない
 *   2. 保持は**日付単位**。同じ日の会場別・レース別ファイルを取りこぼさない
 *   3. 「最新 1 日だけ」に決め打ちしない（取込ズレ・fallback のため 2 日以上）
 *   4. 命名規則から外れるファイルは消さない（fail safe）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  RUNTIME_SUBTREES,
  BUILD_ONLY_SUBTREES,
  KEEP_DATES,
  pickKeepDates,
  shouldKeepFile,
} from './runtimeDataRetention.js';

// ── 1. 全削除対象と実行時サブツリーが重ならない ────────────────
test('実行時に読むサブツリーを全削除対象へ入れていない', () => {
  const runtime = RUNTIME_SUBTREES.map((s) => s.sub);
  for (const b of BUILD_ONLY_SUBTREES) {
    assert.ok(!runtime.includes(b), `${b} は実行時に読むのに全削除対象になっている`);
    // 親ディレクトリごと消して実行時サブツリーを巻き込まないこと
    for (const r of runtime) {
      assert.ok(!r.startsWith(`${b}/`), `${b} を消すと ${r} まで消える`);
    }
  }
});

test('実行時サブツリーが 1 つ以上あり、読み手が記録されている', () => {
  assert.ok(RUNTIME_SUBTREES.length >= 5, `実行時サブツリーが少なすぎる: ${RUNTIME_SUBTREES.length}`);
  for (const s of RUNTIME_SUBTREES) {
    assert.ok(s.sub && s.datePattern instanceof RegExp);
    assert.ok(Array.isArray(s.readers) && s.readers.length > 0, `${s.sub}: 読み手が未記録`);
  }
});

// ── 2. 日付単位で取りこぼさない ──────────────────────────────
test('同じ日の会場別ファイルを全部残す（最新 1 ファイルにしない）', () => {
  const spec = RUNTIME_SUBTREES.find((s) => s.sub === 'featureScores/jra');
  const files = [
    '2026-08-08-CHU.json', '2026-08-08-NII.json', '2026-08-08-SAP.json',
    '2026-08-02-CHU.json', '2026-08-02-NII.json',
    '2026-07-01-TOK.json',
  ];
  const keep = pickKeepDates(files, spec.datePattern, 2);
  assert.deepEqual(keep, ['2026-08-08', '2026-08-02']);
  const kept = files.filter((f) => shouldKeepFile(f, spec.datePattern, keep));
  assert.equal(kept.length, 5, `会場別ファイルを取りこぼしている: ${kept.join(', ')}`);
  assert.ok(kept.includes('2026-08-08-SAP.json'));
  assert.ok(!kept.includes('2026-07-01-TOK.json'));
});

test('日付 × 会場 × レースの 3 段（horseStats）も同じ日をまとめて残す', () => {
  const spec = RUNTIME_SUBTREES.find((s) => s.sub === 'horseStats/nankan');
  const files = [
    '2026-08-07-URA-R01.json', '2026-08-07-URA-R12.json',
    '2026-08-06-FUN-R05.json',
    '2026-05-01-OOI-R01.json',
  ];
  const keep = pickKeepDates(files, spec.datePattern, 2);
  assert.deepEqual(keep, ['2026-08-07', '2026-08-06']);
  const kept = files.filter((f) => shouldKeepFile(f, spec.datePattern, keep));
  assert.equal(kept.length, 3);
  assert.ok(!kept.includes('2026-05-01-OOI-R01.json'));
});

test('predictions/jra は 1 日 1 ファイル（venues[] を内包）', () => {
  const spec = RUNTIME_SUBTREES.find((s) => s.sub === 'predictions/jra');
  assert.ok(spec.datePattern.test('2026-08-08.json'));
  assert.ok(!spec.datePattern.test('2026-08-08-CHU.json'), '会場別名を誤って拾っている');
});

// ── 3. 最新 1 日に決め打ちしない ────────────────────────────
test('KEEP_DATES は 2 以上（取込ズレ・fallback の余裕）', () => {
  assert.ok(KEEP_DATES >= 2, `KEEP_DATES=${KEEP_DATES} は 1 日決め打ちで危険`);
});

test('keepDates に 0 や負を渡しても最低 1 日は残す', () => {
  const spec = RUNTIME_SUBTREES[0];
  for (const n of [0, -1, undefined]) {
    const keep = pickKeepDates(['2026-08-08.json', '2026-08-02.json'], spec.datePattern, n);
    assert.ok(keep.length >= 1, `n=${String(n)} で 0 件になった`);
  }
});

// ── 4. fail safe ────────────────────────────────────────────
test('命名規則から外れるファイルは消さない', () => {
  const spec = RUNTIME_SUBTREES.find((s) => s.sub === 'featureScores/jra');
  for (const odd of ['README.md', 'index.json', 'latest.json', '.DS_Store']) {
    assert.equal(shouldKeepFile(odd, spec.datePattern, ['2026-08-08']), true, `${odd} を消そうとしている`);
  }
});

test('該当ファイルが 1 つも無くても例外にならない', () => {
  const spec = RUNTIME_SUBTREES[0];
  assert.deepEqual(pickKeepDates([], spec.datePattern, 3), []);
  assert.deepEqual(pickKeepDates(null, spec.datePattern, 3), []);
});

// ── 5. prune スクリプトとの配線 ─────────────────────────────
test('prune スクリプトが本ポリシーを使い、全削除へ戻っていない', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../scripts/prune-ssr-function-data.mjs', import.meta.url)), 'utf8'
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /RUNTIME_SUBTREES/, 'ポリシーを読んでいない');
  assert.match(code, /thinRuntimeSubtree/, '間引き処理が無い');
  // 旧実装（HEAVY_SUBTREES を丸ごと rm）へ戻っていない
  assert.doesNotMatch(code, /HEAVY_SUBTREES/, '全削除リストが復活している');
  // 実行時サブツリーを recursive 削除していない
  assert.doesNotMatch(code, /RUNTIME_SUBTREES[\s\S]{0,200}rm\([^)]*recursive/, '実行時サブツリーを丸ごと消している');
  // 0 ファイルになったら失敗させる
  assert.match(code, /kept === 0/, '間引き後 0 件を検知していない');
});
