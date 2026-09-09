/**
 * adminSummaryLayout.guard.test.mjs
 *   管理画面が「状態 → 次の操作 → （折りたたみ）詳細」の順で、
 *   **細かい文章を読まなくても運営できる**形になっていることを固定する
 *
 * 2026-09-09 確定仕様 §0 / §1。運営者が細かい文字を追わないと判断できない状態は未完成。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url).pathname, 'utf8');

const at = (needle) => PAGE.indexOf(needle);

test('順番: 現在の状態 → 次に可能な操作 → 詳細（折りたたみ）', () => {
  const iNow = at("smH.textContent = '現在の状態'");
  const iActs = at("naH.textContent = '次に可能な操作'");
  const iMore = at("moreSum.textContent = '詳細情報と個別操作をひらく'");
  const iInfo = at("h1.textContent = '基本情報'");
  for (const [n, i] of [['現在の状態', iNow], ['次に可能な操作', iActs], ['折りたたみ', iMore]]) {
    assert.ok(i > 0, `${n} の描画が無い`);
  }
  assert.ok(iNow < iActs, '操作が状態より前にある');
  assert.ok(iActs < iMore, '折りたたみが操作より前にある');
  assert.ok(iMore < iInfo, '基本情報が折りたたみより前にある（詳細が主表示のまま）');
});

test('【要件】大きな 1 行 + 色バッジ + 段階 1 行を主表示にする', () => {
  assert.match(PAGE, /smBadge\.className = 'dt-now-badge tone-' \+/, '色バッジが無い');
  assert.match(PAGE, /smBadge\.textContent = summary\.badge/, 'バッジを単一源から取っていない');
  assert.match(PAGE, /smHead\.textContent = summary\.headline/, '大きな 1 行が無い');
  assert.match(PAGE, /smStage\.textContent = summary\.stageLine/, '段階の 1 行が無い');
  // 見出しは十分大きい（細かい文字を読ませない）
  const m = PAGE.match(/\.dt-now-head \{[^}]*font-size:\s*([\d.]+)rem/);
  assert.ok(m && Number(m[1]) >= 1.2, `状態の 1 行が小さい: ${m && m[1]}rem`);
});

test('【要件】詳細セクションは削除せず折りたたみの中に入っている', () => {
  for (const name of ['info', 'upSec', 'psSec', 'rsSec', 'rcSec', 'pvSec', 'secN', 'secD', 'secM', 'secH']) {
    assert.ok(PAGE.includes(`more.appendChild(${name});`), `${name} が折りたたみに入っていない`);
    assert.ok(!PAGE.includes(`body.appendChild(${name});`), `${name} が主表示のまま残っている`);
  }
});

test('【要件】次の操作は大きなボタン（小さなリンクにしない）', () => {
  const m = PAGE.match(/\.dt-act \{[^}]*\}/);
  assert.ok(m, '大ボタンのスタイルが無い');
  assert.match(m[0], /padding:\s*\.8[0-9]?rem/, 'ボタンが小さい');
  const l = PAGE.match(/\.dt-act-l \{[^}]*font-size:\s*([\d.]+)rem/);
  assert.ok(l && Number(l[1]) >= 1, `ボタンの文字が小さい: ${l && l[1]}rem`);
});

test('【要件】出す操作の判定は単一源。画面で条件を作らない', () => {
  assert.match(PAGE, /window\.__ppStatus\.describeNextActions\(r, \{/);
  assert.match(PAGE, /salePauseWritable: r\.salePauseWritable !== false && pauseAvailable\(\)/);
  assert.match(PAGE, /overrideEnabled: data\.overrideEnabled === true/);
});

test('【要件】実行処理を二重実装しない（既存ボタンへ委譲）', () => {
  assert.match(PAGE, /body\.querySelector\('\[data-op="' \+ a\.key \+ '"\]'\)/,
    '大ボタンが既存の実行処理へ委譲していない');
  for (const op of ['salePauseToggle', 'immediate', 'couponPeriod']) {
    assert.ok(PAGE.includes(`dataset.op = '${op}'`), `委譲先 ${op} の目印が無い`);
  }
});

test('押した結果を追えるよう、操作時に詳細を開く', () => {
  assert.match(PAGE, /if \(more\) more\.open = true;/);
});
