/**
 * listFirst.guard.test.mjs — `/free/` の初期表示は「全レースの予想一覧」（2026-09-27 MK 確定）。
 *
 *   上部（囲まれた 1 枚のカード）→ 全レース一覧（各行 = 時刻・R・レース名・[メイン]・◎馬番+馬名・○▲△馬番・詳細）
 *   → 無料登録の案内 1 つ → 見どころの読み方（折りたたみ）→ 実績バナー
 *
 * 分析情報は削除せず「詳細」の中へ。上部にメインレース専用枠を作らない。
 * 2026-09-27 追記（MK 目視）: 副題なし / 会場見出しは範囲表示 / 「詳細」/ 左端の強い色帯なし。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIST_COPY, BANNED_JUDGEMENT_WORDS, BANNED_PAID_TERMS } from './copy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');
const board = read('src/components/RaceViewpointsBoard.astro');
const markup = board.slice(board.indexOf('<section class="rvb">'), board.indexOf('<script is:inline>'));
const at = (needle, from = 0) => {
  const i = markup.indexOf(needle, from);
  assert.ok(i > -1, `${needle} が無い`);
  return i;
};
// JSX コメント（{/* … */}）は表示されないので除いて判定する
const header = markup.slice(0, at('</header>')).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const rowStart = at('<li class={`rvb-row');
const summary = markup.slice(at('<summary class="rvb-detail-sum">', rowStart), at('</summary>', rowStart));
const detailBody = markup.slice(at('<div class="rvb-detail-body">', rowStart), at('</details>', rowStart));

test('上部は最小の囲まれたカード: 使い方・凡例・かんたん表示・会場比較・登録案内を出さない', () => {
  for (const cls of ['rvb-lead', 'rvb-howto', 'rvb-help-toggle', 'rvb-legend', 'rvb-highlight', 'free-signup', 'rvb-topgate', '/pricing/', 'rvb-subtitle', '今日のレースの見どころ']) {
    assert.equal(header.includes(cls), false, `上部に ${cls} がある`);
  }
  const card = header.slice(header.indexOf('class="rvb-headcard"'));
  assert.ok(header.includes('class="rvb-headcard"'), '上部がカードになっていない');
  for (const cls of ['rvb-title', 'rvb-cat', 'rvb-date', 'rvb-freshness', 'LIST_COPY.headFree', 'LIST_COPY.headPaid']) {
    assert.ok(card.includes(cls), `上部カードに ${cls} が無い`);
  }
  assert.ok(LIST_COPY.headPaid.includes('買い目は有料版'), '「買い目は有料版」の案内が無い');
  assert.ok(/\.rvb-headcard\s*\{[^}]*border:[^}]*border-radius/.test(board), 'カードに囲み（境界・角丸）が無い');
});

test('会場見出し・タブを「12R」だけで書かない（最終レース番号に見せない）', () => {
  assert.ok(markup.includes('raceRangeLabel(venue.races)'), '会場見出しが範囲表示になっていない');
  assert.equal(/rvb-venue-count">\{venue\.races\.length\}R</.test(markup), false, '見出しが「12R」表記のまま');
  assert.equal(/rvb-venuetab-count">\{venue\.races\.length\}R</.test(markup), false, 'タブが「12R」表記のまま');
});

test('各レースの左端に強い色帯を付けない', () => {
  assert.equal(/\.rvb-row[^{]*\{[^}]*border-left:\s*[3-9]px/.test(board), false, '行の左端に色帯がある');
  assert.equal(/\.rvb-row\.is-(tagged|neutral|nohistory|pending)\s*\{[^}]*border-left/.test(board), false, '状態別の色帯が残っている');
  assert.equal(/\.rvb-venue-name\s*\{[^}]*border-left/.test(board), false, '会場見出しに色帯がある');
});

test('上部にメインレース専用枠を作らない（一覧と二重表示しない）', () => {
  assert.equal(markup.slice(0, rowStart).includes('rvb-answer'), false);
  assert.equal(markup.slice(0, rowStart).includes('headlineMarksOf'), false, '一覧より前で印を出している');
});

test('各行の初期表示: 時刻・R・レース名・[メイン]・◎馬番+馬名・○▲△馬番・詳細 ▾', () => {
  for (const part of ['rvb-time', 'rvb-r', 'rvb-name', 'rvb-mainbadge', 'isMainRaceIn(venue.races, race)',
    'headlineMarksOf(race.horseRows)', 'rm-mark', 'rm-num', 'rvb-more', 'LIST_COPY.open', '▾']) {
    assert.ok(summary.includes(part), `行に ${part} が無い`);
  }
  assert.equal(LIST_COPY.open, '詳細', '右端の文言は「詳細」');
  assert.equal(LIST_COPY.close, '閉じる');
  // 旧文言「詳しく」を画面に残さない（コメントは除く）
  assert.equal(markup.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').includes('詳しく'), false, '画面に「詳しく」が残っている');
  assert.equal(Object.values(LIST_COPY).filter((v) => typeof v === 'string').some((v) => v.includes('詳しく')), false, '文言に「詳しく」が残っている');
  // 馬名は ◎ だけ（○▲△ は馬番のみ）
  assert.ok(/m\.kind === 'main' && m\.name && <span class="rm-name">/.test(summary), '馬名が ◎ だけになっていない');
  const rest = summary.slice(summary.indexOf('rm-rest'));
  assert.equal(rest.includes('rm-name'), false, '○▲△ に馬名を出している');
});

test('初期表示に条件タグ・説明・分析を出さない（記号も残さない）', () => {
  for (const cls of ['rvb-row-tags', 'rvb-tag-help', 'rvb-tag-ic', 'TAG_ICON', 'TAG_LABEL', 'rvb-meta', 'rvb-horses', 'rvb-highlight', 'rvb-chip']) {
    assert.equal(summary.includes(cls), false, `行（初期表示）に ${cls} がある`);
  }
  const rowHead = markup.slice(rowStart, at('<details class="rvb-detail"', rowStart));
  assert.equal(/rvb-row-tags|rvb-tag-help/.test(rowHead), false, 'details の外にタグがある');
});

test('分析情報は削除せず「詳細」の中にある', () => {
  for (const cls of ['rvb-row-tags', 'rvb-tag-help', 'rvb-sentence', 'rvb-cov', 'rvb-horses', 'rvb-horse-chips',
    'rvb-member-row', 'rvb-mhist', 'rvb-member', 'rvb-cta', 'rvb-closebtn', 'rvb-meta']) {
    assert.ok(detailBody.includes(cls), `詳細の中に ${cls} が無い`);
  }
});

test('行全体が summary（details/summary の既定動作でキーボード・支援技術に対応）', () => {
  assert.ok(markup.slice(rowStart, rowStart + 600).includes('<details class="rvb-detail"'), '行が details になっていない');
  assert.equal(board.includes('preventDefault'), false, 'summary の既定動作を止めている');
  assert.ok(/\.rvb-detail-sum:focus-visible\s*\{[^}]*outline/.test(board), 'キーボードのフォーカス表示が無い');
});

test('無料登録の主 CTA は一覧の後ろに 1 つだけ。レースごとに繰り返さない', () => {
  const ctas = markup.match(/href="\/free-signup\/"/g) || [];
  assert.equal(ctas.length, 1, `登録 CTA が ${ctas.length} か所ある`);
  assert.ok(markup.indexOf('href="/free-signup/"') > at('</ol>'), '登録 CTA が一覧より前');
  assert.equal(detailBody.includes('/free-signup/'), false, '詳細の中に登録 CTA がある');
  assert.ok(detailBody.includes('rvb-signup-mini'), '詳細の中の短い案内が無い');
});

test('並び: 一覧 → 登録案内 → 読み方（折りたたみ）→ 実績バナー', () => {
  const order = ['<ol class="rvb-list"', 'class="rvb-signupbox"', 'class="rvb-guide"', '<slot name="results"', 'class="rvb-foot"'].map((n) => at(n));
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], `並びが崩れている（${i}）`);
  const guide = markup.slice(at('class="rvb-guide"'), at('<slot name="results"'));
  for (const cls of ['rvb-lead', 'rvb-howto', 'rvb-help-toggle', 'rvb-legend']) {
    assert.ok(guide.includes(cls), `読み方に ${cls} が無い`);
  }
  assert.equal(/<details class="rvb-guide"[^>]*\bopen\b/.test(markup), false, '読み方が既定で開いている');
  assert.ok(/<details class="rvb-venuecmp">[\s\S]{0,300}rvb-highlight/.test(markup), '会場比較が折りたたまれていない');
});

test('行カードは開閉とも同じネイビー／シアン系。開閉は強弱だけで示す', () => {
  const rule = (sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = board.match(new RegExp(`${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`));
    assert.ok(m, `${sel} の指定が無い`);
    return m[1];
  };
  const closed = rule('.rvb-row > .rvb-detail:not([open])');
  const open = rule('.rvb-row > .rvb-detail[open]');
  const base = rule('.rvb-row > .rvb-detail');
  for (const [name, css] of [['閉', closed], ['開', open]]) {
    assert.ok(css.includes('rgba(8,47,73'), `${name}: ネイビー系の背景でない`);
    assert.equal(/rgba\((30,41,59|255,255,255)/.test(css), false, `${name}: グレー／白寄りに戻っている`);
  }
  const alpha = (css) => Number((css.match(/border(?:-color)?:[^;]*rgba\(34,211,238,([0-9.]+)\)/) || [])[1]);
  assert.ok(alpha(base) > 0 && alpha(open) > alpha(base), '開いた状態の border が閉じた状態より明るくない');
  assert.equal(/border-left:/.test(base + closed + open), false, '左端の色帯がある');
});

test('一覧の文言に役割名・評価語を書かない', () => {
  const words = Object.entries(LIST_COPY).filter(([k]) => k !== 'headPaid')
    .map(([, v]) => (typeof v === 'function' ? v(12) : v)).join(' ');
  for (const w of [...BANNED_PAID_TERMS, ...BANNED_JUDGEMENT_WORDS]) {
    assert.equal(words.includes(w), false, `文言に「${w}」がある`);
  }
  for (const w of ['本命', '対抗', '単穴', '連下', ...BANNED_JUDGEMENT_WORDS]) {
    assert.equal(LIST_COPY.headPaid.includes(w), false, `headPaid に「${w}」がある`);
  }
});

test('一覧の印は公開 DTO 由来だけ（有料モジュールを読まない）', () => {
  const lib = read('src/lib/freeViewpoints/listView.js');
  for (const bad of ['shared-prediction-logic', 'loadFeatureScores', 'mainRaceBetting', 'osaeClassification', 'computerIndex', 'bettingLines', '.pt', 'role']) {
    assert.equal(lib.includes(bad), false, `listView.js に ${bad} がある`);
  }
});

test('/free-prediction/ は変更しない（無料登録 CTA を置かない）', () => {
  for (const c of ['jra', 'nankan']) {
    const src = read(`src/pages/free-prediction/${c}.astro`);
    assert.equal(src.includes('/free-signup/'), false);
    assert.equal(src.includes('rvb-'), false);
  }
});

test('スマホで読める大きさ（新しい部分は 0.85rem 以上）', () => {
  const css = board.slice(board.indexOf('2026-09-27 MK 確定: 初期表示は全レースの予想一覧'));
  const sizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 0);
  assert.ok(Math.min(...sizes) >= 0.85, `小さすぎる文字: ${Math.min(...sizes)}rem`);
});
