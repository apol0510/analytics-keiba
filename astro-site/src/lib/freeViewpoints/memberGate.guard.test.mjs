/**
 * memberGate.guard.test.mjs
 *
 * 2026-08-20 確定: /race-viewpoints/ に**無料会員登録の特典**を置く。
 *   特典＝拡張表示（出走間隔 / 馬体重の増減 / 条件変化の履歴 / 同条件馬の横比較）
 *
 * 守るべきこと:
 *   - 特典で開くのは**公開事実だけ**。買い目 / pt / AI総合指数 / 役割 / 特徴量は登録しても出さない
 *   - **いま公開しているものを引っ込めてゲートにしない**（第 2 層の存在理由が壊れる）
 *   - 「登録すれば買い目が見える」と読める文言を書かない（有料価値を壊す）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MEMBER_EXTRAS, BANNED_JUDGEMENT_WORDS } from './copy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const board = readFileSync(join(ROOT, 'src/components/RaceViewpointsBoard.astro'), 'utf-8');
const signup = readFileSync(join(ROOT, 'src/pages/free-signup.astro'), 'utf-8');

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join('\n');
const boardCode = stripComments(board);

// ─── ゲートの仕組み ───────────────────────────────────────────

test('拡張表示は既定で隠れ、登録済みでのみ開く', () => {
  assert.ok(board.includes('data-member-only'), '会員限定ブロックの目印が無い');
  assert.ok(board.includes('data-guest-only'), '未登録向けブロックの目印が無い');
  assert.ok(/\[data-member-only\]\s*\{\s*display:\s*none/.test(board),
    '既定で隠す CSS が無い（JS が動かない環境で中身が見えてしまう）');
  assert.ok(board.includes('is-unlocked'), '解放時の class が無い');
});

test('登録判定は他ページと同じ localStorage キーを見る', () => {
  for (const key of ['user-plan', 'user_email', 'isLoggedIn']) {
    assert.ok(board.includes(key), `判定キー ${key} を見ていない`);
  }
});

// ─── 公開中のものをゲートにしない ─────────────────────────────

test('もともと公開している要素に会員ゲートを掛けない', () => {
  // タグ / 状態 / 当日相対 / 出走馬の印 は未登録でも見える必要がある
  for (const cls of ['rvb-row-tags', 'rvb-highlight', 'rvb-horse-mark', 'rvb-horse-name']) {
    const i = boardCode.indexOf(cls);
    assert.ok(i > -1, `${cls} が見つからない`);
    const around = boardCode.slice(Math.max(0, i - 300), i + 300);
    assert.equal(around.includes('data-member-only'), false,
      `${cls} に会員ゲートが掛かっている（公開中のものを引っ込めてはいけない）`);
  }
});

// ─── 特典の中身 ───────────────────────────────────────────────

test('特典は 4 項目そろっている', () => {
  assert.equal(MEMBER_EXTRAS.benefits.length, 4);
  const joined = MEMBER_EXTRAS.benefits.join(' ');
  for (const kw of ['出走間隔', '馬体重', '条件', '比較']) {
    assert.ok(joined.includes(kw), `特典に「${kw}」が含まれていない`);
  }
});

test('拡張ブロックが 4 項目とも描画されている', () => {
  for (const kw of ['extras.interval', 'extras.bodyWeight', 'extras.history', 'sameCondition']) {
    assert.ok(boardCode.includes(kw), `${kw} を描画していない`);
  }
});

// ─── 有料情報を渡さない ───────────────────────────────────────

test('登録しても買い目・pt・指数・役割・特徴量は出さない', () => {
  for (const b of ['bettingLines', 'computerIndex', 'sourceComputerIndex', 'featureScores',
    'analyticsScore', 'displayScore', 'rawScore', 'AI総合指数', '累積スコア', 'horse.role']) {
    assert.equal(boardCode.includes(b), false, `${b} を描画している`);
  }
});

test('「登録すれば買い目が見える」と読める文言を書かない', () => {
  const all = [...Object.values(MEMBER_EXTRAS).flatMap((v) => (Array.isArray(v) ? v : [v]))].join(' ');
  for (const w of ['登録すれば買い目', '登録で買い目', '買い目が見え', '買い目を公開']) {
    assert.equal(all.includes(w), false, `「${w}」は有料価値を壊す`);
  }
  assert.ok(all.includes('買い目は有料版'), '買い目は有料版だけだと明示すること');
  for (const w of BANNED_JUDGEMENT_WORDS) {
    assert.equal(all.includes(w), false, `予想的な評価語「${w}」を混ぜない`);
  }
});

test('登録 CTA は /free-signup/ を指す（プランページではない）', () => {
  const i = boardCode.indexOf('rvb-signup-cta');
  assert.ok(i > -1, '登録 CTA が無い');
  const around = boardCode.slice(Math.max(0, i - 300), i + 300);
  assert.ok(around.includes('/free-signup/'), '登録 CTA が /free-signup/ を指していない');
});

// ─── /free-signup/ の約束と実態を一致させる ───────────────────

test('/free-signup/ が「登録しなくても見られるもの」を特典として約束しない', () => {
  assert.equal(signup.includes('南関競馬のAI無料予想'), false,
    '登録不要で見られるものを特典に挙げている');
  assert.ok(signup.includes('/race-viewpoints/') || signup.includes('出走間隔'),
    '拡張表示が特典として書かれていない');
});
