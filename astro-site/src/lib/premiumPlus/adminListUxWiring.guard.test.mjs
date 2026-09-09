/**
 * adminListUxWiring.guard.test.mjs
 *   一覧画面が「誰が今どの状態か」「次に何を押せるか」を最優先にしていることを固定する
 *
 * 2026-09-09 確定仕様。完成基準は
 *   メールアドレスを入力 → 対象会員が出る → 現在状態が分かる → 必要なボタンを押す
 * までを、細かい説明を読まず数秒で終えられること。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url).pathname, 'utf8');

test('主状態・サマリー・行の操作の判定を単一源へ委譲している', () => {
  assert.match(PAGE, /premiumPlusAdminListView\.js/);
  for (const f of ['classifyListState', 'summarizeListStates', 'listStateFilterOptions',
    'matchesListState', 'findExactEmailMatch', 'describeAttention', 'describeRowActions']) {
    assert.ok(PAGE.includes(f), `単一源の ${f} を使っていない`);
  }
});

test('【重要】メール完全一致 1 件なら、その会員をすぐ操作できる状態にする', () => {
  assert.match(PAGE, /function openExactMatchIfSingle\(\)/);
  assert.match(PAGE, /openExactMatchIfSingle\(\);/, 'render で呼んでいない');
  assert.match(PAGE, /findExactEmailMatch\(lastData\.rows \|\| \[\], q\)/);
  assert.match(PAGE, /openDetail\(hit\.recordId\)/);
});

test('【重要】各行に「詳細・操作」と、結果が名前で分かる操作ボタンがある', () => {
  assert.match(PAGE, /btn\.textContent = '詳細・操作'/);
  assert.match(PAGE, /describeRowActions\(r, \{ salePauseWritable: pauseAvailable\(\) \}\)/);
  assert.match(PAGE, /rb\.dataset\.rowact = a\.key/);
  // 押すとどうなるかを短く併記する
  assert.match(PAGE, /rh\.textContent = a\.enabled === true \? a\.hint : a\.reason/);
  // 実行は詳細パネルの 1 か所へ委譲（確認・履歴・その場更新を二重実装しない）
  assert.match(PAGE, /\[data-op="salePauseToggle"\]/);
});

test('【重要】状態フィルタは単一源が入れる（内部用語を出さない）', () => {
  assert.match(PAGE, /function fillStateFilter\(\)/);
  assert.match(PAGE, /window\.__ppList\.listStateFilterOptions\(\)/);
  assert.match(PAGE, /<select id="fState" aria-label="状態で絞り込み"><\/select>/,
    '選択肢を HTML に直書きしている');
  assert.ok(!PAGE.includes('<option value="immediate">'), '「即時販売」が状態フィルタに残っている');
});

test('【重要】上部は運営サマリー（購入可能 N 名 …）を先に出す', () => {
  assert.match(PAGE, /L\.summarizeListStates\(rowsForSum\)\.items/);
  assert.match(PAGE, /i\.label \+ ' ' \+ i\.count \+ '名'/);
});

test('【重要】効果測定は既定で閉じた折りたたみ（日常運用では読ませない）', () => {
  const m = PAGE.match(/<details class="measure-fold" id="measureFold">[\s\S]{0,400}?<\/details>/);
  assert.ok(m, '効果測定の折りたたみが無い');
  assert.match(m[0], /効果測定を開く/);
  assert.match(m[0], /id="funnelBar"/, '分析バーが折りたたみの外にある');
  assert.ok(!/<details class="measure-fold"[^>]*\sopen[\s>]/.test(PAGE), '既定で開いている');
});

test('要対応（販売可なのに未案内）は対象会員をその場で開ける', () => {
  assert.match(PAGE, /要対応 \$\{notified\.needsAction\} 名を開く/);
  assert.match(PAGE, /\$\('fState'\)\.value = 'sale'/);
});

test('異常のある会員だけ警告を出す（正常に注意文を並べない）', () => {
  assert.match(PAGE, /window\.__ppList\.describeAttention\(r\)/);
  assert.match(PAGE, /if \(warns\.length\)/, '常に警告を出している');
});

test('一覧の状態バッジは大きい（細かい文字を追わせない）', () => {
  const m = PAGE.match(/\.tbl td\.c-state \.badge \{[^}]*font-size:\s*([\d.]+)rem/);
  assert.ok(m && Number(m[1]) >= 0.9, `一覧のバッジが小さい: ${m && m[1]}rem`);
});


test('【重要】「対象外」の理由を一覧のバッジに添えている', () => {
  assert.match(PAGE, /window\.__ppList\.describeStateReason\(r\)/);
  assert.match(PAGE, /rs\.className = 'state-reason'/);
  assert.match(PAGE, /rs\.textContent = reason/, '理由を単一源から取っていない');
  assert.ok(!PAGE.includes("'販売対象外'") || !PAGE.includes("rs.textContent = '販売対象外'"),
    '理由を画面に直書きしている');
});
