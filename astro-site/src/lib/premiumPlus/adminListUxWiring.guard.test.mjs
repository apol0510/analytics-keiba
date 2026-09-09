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

test('【重要】上部は大きな 4 カード（押すとその状態で絞り込む）', () => {
  assert.match(PAGE, /L\.summarizeListStates\(rowsForSum\)\.items/);
  // ⚠️ 2026-09-10: 件数を文言に混ぜない（「購入可能 4名 0」という余計な 0 が出ていた）。
  //    ラベルと件数は別要素に出す。
  assert.match(PAGE, /n\.textContent = String\(it\.count\)/);
  assert.match(PAGE, /l\.textContent = it\.label/);
  assert.ok(!PAGE.includes("i.label + ' ' + i.count + '名'"), '件数を文言に混ぜている');
  assert.match(PAGE, /card\.className = 'sumcard tone-' \+ it\.tone/);
  assert.match(PAGE, /\$\('fState'\)\.value = it\.key/, 'カードで絞り込めない');
  // 数字は大きく出す
  const m = PAGE.match(/\.sumcard \.sc-n \{[^}]*font-size:\s*([\d.]+)rem/);
  assert.ok(m && Number(m[1]) >= 1.8, `カードの数字が小さい: ${m && m[1]}rem`);
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

// ══ 2026-09-10 追加要件（読みやすさ・主入口・行クリック）══════════

test('【要件】会員行はどこを押しても詳細・操作を開く（右端のボタンも残す）', () => {
  assert.match(PAGE, /tr\.classList\.add\('row-clickable'\)/);
  assert.match(PAGE, /tr\.addEventListener\('click', openThis\)/);
  // 行内のボタン・リンクは行クリックとして扱わない（誤操作防止）
  assert.match(PAGE, /closest\('button, a, input, select'\)/);
  // キーボードでも開ける
  assert.match(PAGE, /ev\.key === 'Enter' \|\| ev\.key === ' '/);
  // 右端の「詳細・操作」は残す
  // ⚠️ 2026-09-10: 「作っただけで append していない」ことが実際にあった（E2E で検出）。
  //    生成だけでなく**行に追加している**ことまで見る。
  assert.match(PAGE, /btn\.textContent = '詳細・操作'/);
  assert.match(PAGE, /c8\.appendChild\(btn\)/, '「詳細・操作」を行に追加していない');
});

test('【要件】検索は主入口として常時展開（折りたたまない）', () => {
  assert.match(PAGE, /<div class="email-search open" id="qBox">/);
  assert.ok(!PAGE.includes('<details class="email-search" id="qBox">'), '検索が折りたたまれている');
  assert.match(PAGE, /placeholder="[^"]*完全一致[^"]*"/);
});

test('【要件】細かい条件は「詳細条件を開く」に畳む（既定は閉じる）', () => {
  const m = PAGE.match(/<details class="more-filters" id="moreFilters">[\s\S]*?<\/details>/);
  assert.ok(m, '詳細条件の折りたたみが無い');
  assert.match(m[0], /詳細条件を開く/);
  assert.ok(!/<details class="more-filters"[^>]*\sopen[\s>]/.test(PAGE), '既定で開いている');
  // 通常運用の主表示（検索・状態）は折りたたみの外
  const iState = PAGE.indexOf('<select id="fState"');
  const iMore = PAGE.indexOf('<details class="more-filters"');
  assert.ok(iState > 0 && iMore > 0 && iState < iMore, '状態フィルタが折りたたみの中にある');
  // 細かい条件は中に入っている（削除していない）
  for (const id of ['fPause', 'fCoupon', 'fRoute', 'fKind', 'fUpsell', 'fFunnel', 'fSort']) {
    assert.ok(m[0].includes(`id="${id}"`), `${id} が詳細条件の外にある / 消えている`);
  }
});

test('【要件】管理画面全体の文字が十分大きい（眼精疲労対策）', () => {
  const base = PAGE.match(/\.ppe \{ font-size:\s*(\d+)px/);
  assert.ok(base && Number(base[1]) >= 16, `本文が小さい: ${base && base[1]}px`);
  const tbl = PAGE.match(/\.ppe \.tbl \{ font-size:\s*([\d.]+)rem/);
  assert.ok(tbl && Number(tbl[1]) >= 1, `表の文字が小さい: ${tbl && tbl[1]}rem`);
  const sel = PAGE.match(/\.ppe select, \.ppe input\[type="search"\][^{]*\{[^}]*font-size:\s*([\d.]+)rem/);
  assert.ok(sel && Number(sel[1]) >= 1, `フィルタの文字が小さい: ${sel && sel[1]}rem`);
});
