/**
 * adminMultiFilter.test.mjs — 複数選択フィルター
 *
 * 「期限切れ＋退会済み＋休眠」「Premium＋Light」のような**実際に使う条件**を作れること、
 * そして **同項目 OR / 項目間 AND / 空は条件なし** が崩れないことを固定する。
 * 旧形式（単一文字列）の呼び出しも壊さない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SELECTION, FILTER_LOGIC_NOTE,
  normalizeSelection, validateSelection, matchesAny, matchesAll,
  countApplied, buildChips, removeChip, describeConditions, summarizeSelection,
  selectionsChanged, isActiveMemberIncluded,
  CB_SEGMENT_VALUES, CB_SEGMENT_LABELS, CB_SEGMENT_DEFAULT, CB_SEGMENT_PRESETS,
  PLAN_VALUES, PLAN_LABELS,
} from './adminMultiFilter.js';

// ── 正規化と互換 ────────────────────────────────────────────
test('旧形式（単一文字列）は 1 要素配列として扱う', () => {
  assert.deepEqual(normalizeSelection('expired'), ['expired']);
  assert.deepEqual(normalizeSelection(['expired', 'withdrawn']), ['expired', 'withdrawn']);
});

test('未指定・空・all は「条件なし」', () => {
  for (const v of [undefined, null, '', 'all', [], ['all'], ['', ' ']]) {
    assert.deepEqual(normalizeSelection(v), [], `${JSON.stringify(v)} が条件なしになっていない`);
  }
});

test('重複と空白は落とす', () => {
  assert.deepEqual(normalizeSelection([' premium ', 'premium', 'light']), ['premium', 'light']);
});

// ── 検証 ────────────────────────────────────────────────────
test('許可値だけ通す（未知の値はエラー）', () => {
  assert.deepEqual(validateSelection(['expired', 'withdrawn'], CB_SEGMENT_VALUES),
    { ok: true, values: ['expired', 'withdrawn'] });
  const bad = validateSelection(['expired', 'すべての顧客'], CB_SEGMENT_VALUES, { key: 'contractStates' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /未知の値/);
});

test('件数の上限を超えたらエラー（暴発防止）', () => {
  const many = Array.from({ length: MAX_SELECTION + 1 }, (_, i) => 'v' + i);
  const r = validateSelection(many, many, { key: 'plans' });
  assert.equal(r.ok, false);
  assert.match(r.error, /件までです/);
});

test('空は常に通る（条件なし）', () => {
  assert.deepEqual(validateSelection([], CB_SEGMENT_VALUES), { ok: true, values: [] });
});

// ── OR / AND ────────────────────────────────────────────────
test('同じ項目内は OR', () => {
  const sel = ['expired', 'withdrawn', 'dormant'];
  for (const v of sel) assert.equal(matchesAny(v, sel), true, `${v} が一致しない`);
  assert.equal(matchesAny('active', sel), false);
});

test('未選択の項目は絞り込まない', () => {
  assert.equal(matchesAny('なんでも', []), true);
  assert.equal(matchesAny('なんでも', undefined), true);
});

test('異なる項目間は AND', () => {
  const spec = (contract, plan) => ({
    contract: { value: contract, selection: ['expired', 'withdrawn'] },
    plan: { value: plan, selection: ['premium', 'light'] },
  });
  assert.equal(matchesAll(spec('expired', 'premium')), true);
  assert.equal(matchesAll(spec('expired', 'free')), false, 'プランが外れているのに通っている');
  assert.equal(matchesAll(spec('active', 'premium')), false, '区分が外れているのに通っている');
});

test('片方が未選択なら、もう片方だけで絞る', () => {
  const spec = {
    contract: { value: 'active', selection: [] },
    plan: { value: 'premium', selection: ['premium'] },
  };
  assert.equal(matchesAll(spec), true);
});

test('OR / AND の説明文を持つ', () => {
  assert.match(FILTER_LOGIC_NOTE, /同じ項目内は「いずれか」/);
  assert.match(FILTER_LOGIC_NOTE, /異なる項目間は「すべて一致」/);
});

// ── 画面表示 ────────────────────────────────────────────────
const labels = { contractStates: CB_SEGMENT_LABELS, plans: PLAN_LABELS };
const sel = { contractStates: ['expired', 'withdrawn', 'dormant'], plans: ['premium', 'light'] };

test('適用中の条件数は「選んだ値の数」', () => {
  assert.equal(countApplied(sel), 5);
  assert.equal(countApplied({}), 0);
});

test('チップは 1 件ずつ外せる', () => {
  const chips = buildChips(sel, labels);
  assert.equal(chips.length, 5);
  assert.deepEqual(chips[0], { key: 'contractStates', value: 'expired', label: '期限切れ' });
  const after = removeChip(sel, 'plans', 'light');
  assert.deepEqual(after.plans, ['premium']);
  assert.deepEqual(after.contractStates, sel.contractStates, '他の項目まで消している');
});

test('条件を自然文で要約する', () => {
  const t = describeConditions(sel, labels, ['contractStates', 'plans']);
  assert.match(t, /期限切れ・退会・課金停止・休眠・長期未ログイン/);
  assert.match(t, /Premium・Light/);
  assert.match(t, /検索します。$/);
  assert.match(describeConditions({}, labels), /条件を指定していません/);
});

test('全項目 ON は「全〜」と短く言う', () => {
  assert.equal(summarizeSelection([], PLAN_VALUES), '指定なし');
  assert.equal(summarizeSelection(['premium', 'light'], PLAN_VALUES), '2件選択');
  assert.equal(summarizeSelection([...PLAN_VALUES], PLAN_VALUES, '全プラン'), '全プラン');
});

// ── カムバックの既定とプリセット ────────────────────────────
test('初期状態は 期限切れ・退会済み・休眠 が ON', () => {
  assert.deepEqual([...CB_SEGMENT_DEFAULT], ['expired', 'withdrawn', 'dormant']);
  assert.equal(CB_SEGMENT_DEFAULT.includes('none'), false, '無料会員が既定 ON になっている');
  assert.equal(CB_SEGMENT_DEFAULT.includes('unknown'), false, '状態不明が既定 ON になっている');
});

test('現有効会員は通常候補の選択肢に含めない', () => {
  assert.equal(CB_SEGMENT_VALUES.includes('active'), false, '通常候補に現有効会員が混ざっている');
  for (const p of Object.values(CB_SEGMENT_PRESETS)) {
    assert.equal(p.values.includes('active'), false, `プリセット ${p.label} に現有効会員が入っている`);
  }
  assert.equal(isActiveMemberIncluded(['expired']), false);
  assert.equal(isActiveMemberIncluded(['expired', 'active']), true, '別枠の指定を検知できていない');
});

test('プリセットは安全な候補を一括 ON にする', () => {
  assert.deepEqual(CB_SEGMENT_PRESETS.standard.values, ['expired', 'withdrawn', 'dormant']);
  assert.deepEqual(CB_SEGMENT_PRESETS.clear.values, []);
  assert.deepEqual(CB_SEGMENT_PRESETS.all.values, [...CB_SEGMENT_VALUES]);
  assert.equal(CB_SEGMENT_PRESETS.expired.values.length, 1);
});

test('「すべて」というチェック項目を作らない', () => {
  assert.equal(CB_SEGMENT_VALUES.includes('all'), false);
  assert.equal(PLAN_VALUES.includes('all'), false);
});

// ── 変更検知 ────────────────────────────────────────────────
test('条件が変わったら検知する（並び順の違いは無視）', () => {
  assert.equal(selectionsChanged(sel, { ...sel, plans: ['light', 'premium'] }), false, '並び替えで失効している');
  assert.equal(selectionsChanged(sel, { ...sel, plans: ['premium'] }), true);
  assert.equal(selectionsChanged(sel, {}), true);
  assert.equal(selectionsChanged({}, {}), false);
});

test('ラベルが全値にある（画面で値そのものを出さない）', () => {
  for (const v of CB_SEGMENT_VALUES) assert.ok(CB_SEGMENT_LABELS[v], `${v} のラベルが無い`);
  for (const v of PLAN_VALUES) assert.ok(PLAN_LABELS[v], `${v} のラベルが無い`);
});
