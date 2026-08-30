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
  MAX_AHEAD_DAYS,
  addDaysIso,
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

// ── 6. 成果物チェッカーの突き合わせ単位 ─────────────────────
test('成果物チェッカーは会場ごとに数える（複数会場開催で誤検知しない）', () => {
  // 2026-08-12（浦和 12R + 別会場 10R = 22 件）で、浦和の 12 件を
  // 「その日の全会場 22 件」と比べて "prune がレース単位で取りこぼしている" と
  // 誤検知し、CI が落ちた。突き合わせは必ず会場スコープで行う。
  const src = readFileSync(
    fileURLToPath(new URL('../../../scripts/check-ssr-runtime-data.mjs', import.meta.url)), 'utf8'
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /function sourceCountFor\(sub, date, code\)/, '会場を受け取っていない');
  assert.match(code, /const prefix = code \? `\$\{date\}-\$\{code\}-` : `\$\{date\}-`/);
  // horseStats（レース単位）の突き合わせは会場を必ず渡す
  const calls = code.match(/sourceCountFor\('horseStats\/nankan', date[^)]*\)/g) || [];
  assert.ok(calls.length >= 2, 'horseStats の突き合わせが見当たらない');
  for (const c of calls) {
    assert.match(c, /date, code\)/, `会場スコープで数えていない: ${c}`);
  }
});

// ── 7. computer サブツリー（/dark-horse-picks/ の SSR 化・2026-08-30）─────────
//
// 守りたい事故: 穴馬抽出ページが `prerender = true` のままビルド時刻で当日を決めており、
// 当日は終日「前日の穴馬」が出ていた。SSR 化で **実行時に src/data/computer を読む**
// ようになったため、prune が computer を丸ごと消すと当日分が引けなくなる。

test('computer/{jra,nankan} は実行時サブツリー（全削除対象に戻っていない）', () => {
  const subs = RUNTIME_SUBTREES.map((s) => s.sub);
  assert.ok(subs.includes('computer/jra'), 'computer/jra が実行時サブツリーに無い');
  assert.ok(subs.includes('computer/nankan'), 'computer/nankan が実行時サブツリーに無い');
  assert.ok(!BUILD_ONLY_SUBTREES.includes('computer'), "'computer' を全削除対象へ戻している");
  for (const b of BUILD_ONLY_SUBTREES) {
    assert.ok(!'computer/jra'.startsWith(`${b}/`), `${b} を消すと computer/jra まで消える`);
  }
});

test('computer の datePattern は会場別ファイル名を拾う', () => {
  const spec = RUNTIME_SUBTREES.find((s) => s.sub === 'computer/jra');
  assert.ok(spec.datePattern.test('2026-08-30-NII.json'));
  assert.ok(spec.datePattern.test('2026-08-30-CHU.json'));
  assert.equal(spec.datePattern.exec('2026-08-30-SAP.json')[1], '2026-08-30');
  assert.ok(!spec.datePattern.test('2026-08-30.json'), '日付だけのファイル名を誤って拾っている');
});

test('同日 3 会場（JRA）を取りこぼさない', () => {
  const spec = RUNTIME_SUBTREES.find((s) => s.sub === 'computer/jra');
  const files = ['2026-08-30-NII.json', '2026-08-30-CHU.json', '2026-08-30-SAP.json', '2026-08-23-TOK.json'];
  const keep = pickKeepDates(files, spec.datePattern, 1);
  const kept = files.filter((f) => shouldKeepFile(f, spec.datePattern, keep));
  assert.equal(kept.length, 3, `会場を取りこぼしている: ${kept.join(', ')}`);
});

// ── 8. maxAheadDays: 先行投入された未来日で「配信当日」を消さない ───────────
test('未来日が先行投入されても、ビルド日+1 以内に絞って当日分を残す', () => {
  const spec = RUNTIME_SUBTREES.find((s) => s.sub === 'computer/jra');
  assert.equal(spec.maxAheadDays, MAX_AHEAD_DAYS);

  // ビルド 2026-08-29 夕方。翌週 9/5・9/6・9/12 が先行投入済み。
  const files = [
    '2026-09-12-TOK.json', '2026-09-06-NAK.json', '2026-09-05-NAK.json',
    '2026-08-30-NII.json', '2026-08-29-NII.json', '2026-08-23-TOK.json',
  ];
  const maxDate = addDaysIso('2026-08-29', MAX_AHEAD_DAYS); // 2026-08-30
  assert.equal(maxDate, '2026-08-30');

  const keep = pickKeepDates(files, spec.datePattern, KEEP_DATES, maxDate);
  assert.ok(keep.includes('2026-08-30'), `配信当日 2026-08-30 が消える: ${keep.join(', ')}`);
  assert.ok(keep.includes('2026-08-29'), `ビルド当日 2026-08-29 が消える: ${keep.join(', ')}`);
  assert.ok(!keep.includes('2026-09-12'), '上限を超える未来日を残している');

  // 上限を渡さない旧挙動だと当日が落ちる（＝この上限が必要な理由）
  const noCap = pickKeepDates(files, spec.datePattern, KEEP_DATES);
  assert.ok(!noCap.includes('2026-08-30'), '前提が崩れている（上限なしでも当日が残っている）');
});

test('maxDate 未指定・不正なら従来どおり新しい順（既存 5 サブツリーの挙動は不変）', () => {
  const spec = RUNTIME_SUBTREES.find((s) => s.sub === 'featureScores/jra');
  const files = ['2026-08-30-NII.json', '2026-08-29-NII.json', '2026-08-23-TOK.json'];
  const base = pickKeepDates(files, spec.datePattern, 2);
  assert.deepEqual(base, ['2026-08-30', '2026-08-29']);
  for (const bad of [null, undefined, '', 'nope', 20260830]) {
    assert.deepEqual(pickKeepDates(files, spec.datePattern, 2, bad), base, `maxDate=${String(bad)} で挙動が変わった`);
  }
  assert.ok(RUNTIME_SUBTREES.filter((s) => s.maxAheadDays == null).length >= 5, '既存 5 サブツリーへ上限を足していない');
});

test('上限以下の日付が 1 つも無ければ間引きで 0 件にしない（fail safe）', () => {
  const spec = RUNTIME_SUBTREES.find((s) => s.sub === 'computer/jra');
  const files = ['2026-09-05-NAK.json', '2026-09-06-NAK.json'];
  const keep = pickKeepDates(files, spec.datePattern, KEEP_DATES, '2026-08-30');
  assert.ok(keep.length >= 1, '未来日しか無いときに 0 件へ落としている');
});

test('addDaysIso は暦日で進み、不正入力は null', () => {
  assert.equal(addDaysIso('2026-08-29', 1), '2026-08-30');
  assert.equal(addDaysIso('2026-08-31', 1), '2026-09-01');
  assert.equal(addDaysIso('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysIso('2026-08-30', 0), '2026-08-30');
  assert.equal(addDaysIso('2026-08-30', -1), '2026-08-29');
  for (const bad of [null, undefined, '', 'nope', '2026-8-30']) assert.equal(addDaysIso(bad, 1), null);
  assert.equal(addDaysIso('2026-08-30', NaN), null);
});

test('prune スクリプトが maxAheadDays を実際に配線している', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../scripts/prune-ssr-function-data.mjs', import.meta.url)), 'utf8'
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /maxAheadDays/, 'maxAheadDays を読んでいない');
  assert.match(code, /addDaysIso/, '上限日を計算していない');
  assert.match(code, /pickKeepDates\([\s\S]{0,160}?maxDate\)/, 'pickKeepDates へ上限日を渡していない');
});

// ── 9. ソース検査ガード自体が無効化されないこと ──────────────────────────
//
// 上のいくつかのテストは「スクリプトのソースからブロックコメントを除いて grep」する。
// ところが**文字列リテラルの中に `/*` が入っている**と（例: 'predictions/*.json'）、
// あとから追加された別のブロックコメントの `*/` と対になり、**その間のコードが
// まるごと除去されて grep が素通り**する。2026-08-30 に実際これが起き、
// horseStats の突き合わせ検査が「見当たらない」と誤検知した（本物の退行ではなかった）。
// 文字列中の `/*` を機械的に禁止して、ガードが静かに死ぬ経路を塞ぐ。
test('検査対象スクリプトの文字列リテラルに "/*" を書かない（grep ガードの無効化防止）', () => {
  for (const rel of ['../../../scripts/check-ssr-runtime-data.mjs', '../../../scripts/prune-ssr-function-data.mjs']) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    src.split('\n').forEach((line, i) => {
      // ブロックコメント本文（先頭が * や /* や //）は対象外。コメント内の "/*" は無害。
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
      for (const lit of line.match(/'[^']*'|"[^"]*"|`[^`]*`/g) || []) {
        assert.ok(!lit.includes('/*'),
          `${rel}:${i + 1} 文字列 ${lit} に "/*" が含まれる。`
          + ' コメント除去が後続の */ と対になり、grep ガードが素通りする');
      }
    });
  }
});
