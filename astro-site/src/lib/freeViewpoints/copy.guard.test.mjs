import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TAG_LABEL, TAG_SENTENCE, STATE_LABEL, STATE_SENTENCE, HIGHLIGHT_LABEL,
  BANNED_JUDGEMENT_WORDS, BANNED_PAID_TERMS, coverageNote,
  PAID_CTA, HORSE_SECTION, HORSE_CHANGE_CHIP, TAG_ICON, STATE_ICON,
} from './copy.js';
import { TAG, RACE_STATE } from './raceViewpoints.js';

const allText = () => [
  ...Object.values(TAG_LABEL), ...Object.values(TAG_SENTENCE),
  ...Object.values(STATE_LABEL), ...Object.values(STATE_SENTENCE),
  ...Object.values(HIGHLIGHT_LABEL),
];

test('すべての文言に予想的な評価語を混ぜない（CTA も含む）', () => {
  const all = [...allText(), ...Object.values(PAID_CTA), ...Object.values(HORSE_SECTION),
    ...Object.values(HORSE_CHANGE_CHIP).map((c) => c.label)];
  for (const text of all) {
    for (const w of BANNED_JUDGEMENT_WORDS) {
      assert.equal(text.includes(w), false, `「${w}」が文言に混ざっている: ${text}`);
    }
  }
});

test('タグ・状態・当日相対の文言に有料項目名を出さない', () => {
  for (const text of allText()) {
    for (const w of BANNED_PAID_TERMS) {
      assert.equal(text.includes(w), false, `「${w}」が文言に混ざっている: ${text}`);
    }
  }
});

test('CTA は買い目が有料版で見られることを伝える（/free-prediction/ を有料版プレビューとして案内）', () => {
  const joined = Object.values(PAID_CTA).join(' ');
  assert.ok(joined.includes('買い目'), '買い目に言及すること');
  assert.ok(joined.includes('有料版'), '有料版で見られると伝えること');
  assert.ok(joined.includes('無料予想'), '/free-prediction/ を案内すること');
  assert.equal(/\d\s*[→↔⇔-]\s*\d/.test(joined), false, '実際の買い目（馬番の組み合わせ）を書かない');
  assert.equal(PAID_CTA.linkLabel.includes('出走馬・印を見る'), false, '旧 CTA の文言に戻さない');
});

test('馬単位チップは色に依存せず記号と文字を持つ', () => {
  for (const [key, chip] of Object.entries(HORSE_CHANGE_CHIP)) {
    assert.ok(chip.label && chip.label.length > 0, `${key} に文字ラベルが無い`);
    assert.ok(chip.icon && chip.icon.length > 0, `${key} に記号が無い`);
    assert.ok(chip.kind && chip.kind.length > 0, `${key} に色分けキーが無い`);
  }
  const kinds = new Set(Object.values(HORSE_CHANGE_CHIP).map((c) => c.kind));
  assert.equal(kinds.size, Object.keys(HORSE_CHANGE_CHIP).length, '意味ごとに別の色分けキーを持つこと');
});

test('タグ・状態にも記号がある（色だけに依存しない）', () => {
  for (const t of Object.keys(TAG_LABEL)) assert.ok(TAG_ICON[t], `${t} の記号が無い`);
  for (const s of Object.keys(STATE_LABEL)) assert.ok(STATE_ICON[s], `${s} の記号が無い`);
});

test('全タグ・全状態に文言が定義されている（表示漏れ防止）', () => {
  for (const t of Object.values(TAG)) {
    assert.ok(TAG_LABEL[t], `${t} のラベルが無い`);
    assert.ok(TAG_SENTENCE[t], `${t} の説明文が無い`);
  }
  for (const s of [RACE_STATE.NEUTRAL, RACE_STATE.NO_HISTORY, RACE_STATE.UNMATCHED]) {
    assert.ok(STATE_LABEL[s], `${s} のラベルが無い`);
    assert.ok(STATE_SENTENCE[s], `${s} の説明文が無い`);
  }
});

test('中立は 1 つの意味に固定する（弱いシグナルを別文言にしない）', () => {
  assert.equal(typeof STATE_LABEL[RACE_STATE.NEUTRAL], 'string');
  const neutral = STATE_LABEL[RACE_STATE.NEUTRAL] + STATE_SENTENCE[RACE_STATE.NEUTRAL];
  for (const w of ['やや', '少し', 'わずかに', 'どちらかといえば', '寄り']) {
    assert.equal(neutral.includes(w), false, `中立文に程度差の表現「${w}」を入れない`);
  }
});

test('「照合できていない」と「近走なし」を同じ文言にしない', () => {
  const a = STATE_LABEL[RACE_STATE.UNMATCHED] + STATE_SENTENCE[RACE_STATE.UNMATCHED];
  const b = STATE_LABEL[RACE_STATE.NO_HISTORY] + STATE_SENTENCE[RACE_STATE.NO_HISTORY];
  assert.notEqual(a, b);
  assert.ok(a.includes('確認できていません'), '準備中は「こちらが確認できていない」と書く');
  assert.ok(b.includes('記録がありません'), '近走なしは「走っていない」と書く');
});

test('照合注記は実数で出す（割合で全体を語らない）', () => {
  const unmatched = coverageNote({ state: RACE_STATE.UNMATCHED, matched: 14, entryCount: 16 });
  assert.ok(unmatched.includes('16頭中 14頭'), `実数表示になっていない: ${unmatched}`);
  assert.equal(unmatched.includes('%'), false, '割合で語らない');

  const full = coverageNote({ state: RACE_STATE.TAGGED, matched: 12, entryCount: 12 });
  assert.ok(full.includes('12頭すべて'));

  const none = coverageNote({ state: RACE_STATE.NO_HISTORY, matched: 8, entryCount: 8 });
  assert.ok(none.includes('近走なし'));
  assert.ok(!none.includes('照合できていません'), '未出走を照合失敗の文言で説明しない');
});
