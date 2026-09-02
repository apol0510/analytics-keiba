/**
 * mainRaceGci.test.mjs — G-CI（抑え最上位昇格）通常レースロジックの回帰テスト。
 *
 * 実行: node --test src/utils/mainRaceGci.test.mjs
 * AK のテスト規約（node:test / node:assert・新規依存なし・実通信なし）に従う。
 *
 * 目的（PR #115 をマージ可能な完成状態に固定する）:
 *   1. G-CI の中核条件（発動/非発動・候補決定・買い目構造）を決定的 fixture で固定。
 *   2. メインレース非影響（G-CI は通常レースのみ・メイン生成は従来 F3 のまま）を固定。
 *   3. Light 4 ページ / Premium JRA の「保存 bettingLines.umatan を正本参照」への収束を
 *      ソース静的検査で固定（ローカル買い目生成が復活していないことを検知）。
 *
 * 方針: 画面全体の重い fixture は複製しない。純粋ロジック（generateNormalRaceUmatanLines /
 *   generateMainRaceUmatanLines / getTopOsaeCandidate / getOsaeCi）を最小の決定的 fixture で検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  generateNormalRaceUmatanLines,
  generateMainRaceUmatanLines,
  generateRaceUmatanLines,
  getMainRaceNumber,
} from './mainRaceBetting.js';
import { getOsaeCi, getTopOsaeCandidate } from './osaeClassification.js';

// ── fixture helpers ─────────────────────────────────────────────
// 南関馬（computerIndex）。ci 省略で指数なし。
const H = (number, role, pt, ci) =>
  ci === undefined ? { number, role, pt } : { number, role, pt, computerIndex: ci };
// JRA 馬（sourceComputerIndex 優先 / computerIndex 併記可）。
const HJ = (number, role, pt, sci, ci) => {
  const h = { number, role, pt };
  if (sci !== undefined) h.sourceComputerIndex = sci;
  if (ci !== undefined) h.computerIndex = ci;
  return h;
};
// 通常レースは双方向「↔」、メインレースは一方向「→」。どちらの区切りでも相手を取り出す。
const partnersOf = (line) => line.split('(')[0].split(/[↔→]/)[1].split('.');
const stripCI = (hs) => hs.map((h) => { const { computerIndex, sourceComputerIndex, ...rest } = h; return { ...rest }; });

// 基準レース: 本命1 / 対抗2 / 単穴3 / 連下最上位4 / 連下5(pt50) / 連下6(pt40,CI40) / 補欠7(CI45)。
// 各軸段の相手5位 = #6（連下, CI40）。抑え最上位 = #7（補欠, CI45 = 40+5 → 差5 境界で発動）。
const raceFire = () => [
  H(1, '本命', 90),
  H(2, '対抗', 80),
  H(3, '単穴', 70),
  H(4, '連下最上位', 60),
  H(5, '連下', 50),
  H(6, '連下', 40, 40),
  H(7, '補欠', 10, 45),
];

// ── G-CI 発動条件 ───────────────────────────────────────────────
test('CI差5ちょうどで相手5位(#6)を抑え最上位(#7)へ昇格（両軸段）', () => {
  assert.deepStrictEqual(generateNormalRaceUmatanLines(raceFire()), ['1↔2.3.4.5.7', '2↔1.3.4.5.7']);
});

test('CI差4では非発動（#7は昇格せず抑え欄へ）', () => {
  const race = raceFire();
  race[5].computerIndex = 41; // #6 CI41
  race[6].computerIndex = 45; // #7 CI45 → 45 >= 41+5(=46) 不成立 → 非発動
  assert.deepStrictEqual(generateNormalRaceUmatanLines(race), ['1↔2.3.4.5.6(抑え7)', '2↔1.3.4.5.6(抑え7)']);
});

test('CI45未満の抑え候補は対象外（getTopOsaeCandidate=null・非発動）', () => {
  const race = raceFire();
  race[5].computerIndex = 40;
  race[6].computerIndex = 44; // <45 → 抑え候補にならない
  assert.strictEqual(getTopOsaeCandidate(race), null);
  assert.deepStrictEqual(generateNormalRaceUmatanLines(race), ['1↔2.3.4.5.6', '2↔1.3.4.5.6']);
});

test('CI欠損時は従来F3へフォールバック（役割のみ出力と一致）', () => {
  const noCi = stripCI(raceFire());
  assert.strictEqual(getTopOsaeCandidate(noCi), null);
  assert.deepStrictEqual(generateNormalRaceUmatanLines(noCi), ['1↔2.3.4.5.6', '2↔1.3.4.5.6']);
});

test('抑え候補が存在しなければ非発動', () => {
  const race = raceFire().slice(0, 6); // #7(補欠) を除去
  assert.deepStrictEqual(generateNormalRaceUmatanLines(race), ['1↔2.3.4.5.6', '2↔1.3.4.5.6']);
});

test('相手5位が連下でなければ非発動（CI99の候補があっても）', () => {
  const race = [
    H(1, '本命', 90), H(2, '対抗', 80), H(3, '単穴', 70),
    H(4, '連下最上位', 60), H(5, '連下最上位', 55), H(6, '連下最上位', 50),
    H(7, '補欠', 10, 99), H(8, '連下', 5),
  ];
  // 相手5位 = #6（連下最上位）→ role≠連下 で非発動。#7 は抑え欄。
  assert.deepStrictEqual(generateNormalRaceUmatanLines(race), ['1↔2.3.4.5.6(抑え7)', '2↔1.3.4.5.6(抑え7)']);
});

test('相手が5頭未満なら非発動', () => {
  const race = [H(1, '本命', 90), H(2, '対抗', 80), H(3, '単穴', 70), H(7, '補欠', 10, 99)];
  assert.deepStrictEqual(generateNormalRaceUmatanLines(race), ['1↔2.3(抑え7)', '2↔1.3(抑え7)']);
});

// ── 候補決定（CI降順 → pt降順 → 馬番昇順 / JRA=sci優先・南関=ci） ─────────
test('候補はCI降順で決定', () => {
  assert.strictEqual(getTopOsaeCandidate([H(7, '補欠', 10, 50), H(8, '補欠', 10, 60)]).number, 8);
});

test('CI同値ならpt降順', () => {
  assert.strictEqual(getTopOsaeCandidate([H(7, '補欠', 10, 50), H(8, '補欠', 20, 50)]).number, 8);
});

test('CI・pt同値なら馬番昇順', () => {
  assert.strictEqual(getTopOsaeCandidate([H(7, '補欠', 10, 50), H(9, '補欠', 10, 50)]).number, 7);
});

test('JRAでは sourceComputerIndex を優先', () => {
  assert.strictEqual(getOsaeCi(HJ(1, '補欠', 0, 50, 10)), 50);   // sci=50 > ci=10 → 50
  assert.strictEqual(getOsaeCi(HJ(1, '補欠', 0, 50, 99)), 50);   // sci 優先で ci99 を無視
  // sci で候補決定: #7(sci60) > #8(sci50, ci99) → #7
  assert.strictEqual(getTopOsaeCandidate([HJ(7, '補欠', 10, 60, 10), HJ(8, '補欠', 10, 50, 99)]).number, 7);
});

test('南関では computerIndex を使用（10未満は0）', () => {
  assert.strictEqual(getOsaeCi({ computerIndex: 50 }), 50);
  assert.strictEqual(getOsaeCi({ computerIndex: 8 }), 0);
  assert.strictEqual(getOsaeCi({}), 0);
});

test('JRA sourceComputerIndex 経由でG-CI発動（通常レース）', () => {
  const race = [
    H(1, '本命', 90), H(2, '対抗', 80), H(3, '単穴', 70), H(4, '連下最上位', 60), H(5, '連下', 50),
    HJ(6, '連下', 40, 40), HJ(7, '補欠', 10, 50),
  ];
  assert.deepStrictEqual(generateNormalRaceUmatanLines(race), ['1↔2.3.4.5.7', '2↔1.3.4.5.7']);
});

// ── 買い目構造 ──────────────────────────────────────────────────
test('本命軸段と第二軸段を独立判定し、両段で同じ候補(#7)を昇格できる', () => {
  const [line0, line1] = generateNormalRaceUmatanLines(raceFire());
  assert.ok(partnersOf(line0).includes('2'), '本命軸段の相手に対抗#2を含む（本命プール）');
  assert.ok(partnersOf(line1).includes('1'), '第二軸段の相手に本命#1を含む（対抗プール）');
  assert.ok(partnersOf(line0).includes('7') && partnersOf(line1).includes('7'), '両段で#7を昇格');
});

test('昇格馬を本線と抑え欄へ二重表示しない（抑え欄が非空でも）', () => {
  const race = raceFire();
  race[6].computerIndex = 50;            // #7 CI50 → 昇格
  race.push(H(8, '補欠', 5, 46));        // #8 CI46 → 抑え欄に残す
  const [line0] = generateNormalRaceUmatanLines(race);
  assert.strictEqual(line0, '1↔2.3.4.5.7(抑え8)');
  assert.ok(partnersOf(line0).includes('7'), '#7は本線');
  assert.ok(!line0.includes('抑え7') && !line0.includes('.7)'), '#7は抑え欄に出さない');
  assert.ok(line0.includes('抑え8'), '#8は抑え欄');
});

test('相手数を増やさない（各段の相手は最大5頭）', () => {
  for (const line of generateNormalRaceUmatanLines(raceFire())) {
    assert.strictEqual(partnersOf(line).length, 5);
  }
});

test('同一の順序付き馬単を重複生成しない（段内の相手は一意・2段は別軸）', () => {
  const lines = generateNormalRaceUmatanLines(raceFire());
  for (const line of lines) {
    const p = partnersOf(line);
    assert.strictEqual(new Set(p).size, p.length, '段内で相手重複なし');
  }
  assert.notStrictEqual(lines[0], lines[1], '2段は異なる軸＝異なる順序付き馬単');
});

// ── メインレース非影響 ───────────────────────────────────────────
test('メインレース生成は一方向「本命→相手5頭」5点（G-CIの差し替えを行わない）', () => {
  const main = generateRaceUmatanLines(raceFire(), true);
  assert.deepStrictEqual(main, generateMainRaceUmatanLines(raceFire()));
  assert.deepStrictEqual(main, ['1→2.3.4.5.6(抑え7)']); // 一方向→ / 相手5位#6は #7へ差し替えない
});

test('G-CIは通常レースだけに適用（同一レースでメイン=#6維持 / 通常=#7昇格）', () => {
  const mainPartners = partnersOf(generateRaceUmatanLines(raceFire(), true)[0]);
  const normalPartners = partnersOf(generateRaceUmatanLines(raceFire(), false)[0]);
  assert.ok(mainPartners.includes('6') && !mainPartners.includes('7'), 'メインは#6維持');
  assert.ok(normalPartners.includes('7') && !normalPartners.includes('6'), '通常は#7昇格');
});

test('メインレースは補欠を本線相手へ昇格しない', () => {
  const race = raceFire();
  const hoketsuNums = new Set(race.filter((h) => h.role === '補欠').map((h) => String(h.number)));
  const partners = partnersOf(generateMainRaceUmatanLines(race)[0]);
  assert.ok(!partners.some((p) => hoketsuNums.has(p)), 'メイン相手に補欠を含まない');
});

test('CI条件不成立時の通常レース出力は従来F3（CI有無で同一）', () => {
  const race = raceFire();
  race[5].computerIndex = 40;
  race[6].computerIndex = 44; // 条件不成立
  assert.deepStrictEqual(generateNormalRaceUmatanLines(race), generateNormalRaceUmatanLines(stripCI(race)));
});

test('getMainRaceNumber は開催数から一意にメインを決める', () => {
  assert.strictEqual(getMainRaceNumber(12), 11);
  assert.strictEqual(getMainRaceNumber(10), 9);
  assert.strictEqual(getMainRaceNumber(8), 7);
  assert.strictEqual(getMainRaceNumber(9), 9); // それ以外は最終R
});

// ── Light・Premium 正本収束（ソース静的検査） ─────────────────────
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
// 2026-09-02: 会場別 2 ページ（-urawa / -funabashi）は **301 リダイレクトのみ**へ畳んだ。
// サイト内から一切リンクされておらず、`/light-predictions/` が会場を問わず南関の
// 最新開催日を表示するため機能的に重複していた（重複したまま直すと片側が旧仕様で残る）。
// 予想を描画する Light ページはこの 2 枚だけ。
// 畳んだ 2 枚が予想描画に戻っていないことは
// `src/lib/navigation/memberPredictionFunnel.guard.test.mjs` が検査する。
const LIGHT_PAGES = [
  '../pages/light-predictions.astro',
  '../pages/light-predictions-jra.astro',
];

test('4つのLightページにローカル generateOneLineUmatanBets が残っていない', () => {
  for (const p of LIGHT_PAGES) {
    assert.ok(!src(p).includes('generateOneLineUmatanBets'), `${p} に generateOneLineUmatanBets が残存`);
  }
});

test('Premium JRA にローカル generateUmatanBets が残っていない', () => {
  assert.ok(!/\bgenerateUmatanBets\b/.test(src('../pages/premium-prediction/jra.astro')), 'generateUmatanBets が残存');
});

test('Lightは保存 bettingLines.umatan を参照する（正本パース）', () => {
  for (const p of LIGHT_PAGES) {
    const s = src(p);
    assert.ok(s.includes('parseMainUmatanForDisplay'), `${p} が正本パースを使っていない`);
    assert.ok(s.includes('bettingLines'), `${p} が bettingLines を参照していない`);
  }
});

test('Premium JRA は保存 bettingLines.umatan を優先（無ければ正本生成へフォールバック）', () => {
  const s = src('../pages/premium-prediction/jra.astro');
  assert.ok(s.includes('bettingLines?.umatan'), '保存 bettingLines?.umatan を参照していない');
  assert.ok(s.includes('generateRaceUmatanLines'), 'フォールバックの正本生成を参照していない');
});

test('予想を描画する全Lightページがメインレース買い目だけを表示する既存ゲートを維持', () => {
  for (const p of LIGHT_PAGES) {
    const s = src(p);
    assert.ok(s.includes('standardRaces') || s.includes('PLAN_ACCESS.standard'), `${p} のメイン限定ゲートが消えている`);
  }
});

// ── Premium 表示から内部保険「(抑え…)」を非表示（案B・表示層のみ） ─────────
// 変換仕様はコードの stripOsaeForDisplay と同一の正規表現で固定する。
const OSAE_STRIP_RE = /[(（]抑え[^)）]*[)）]/g;
const stripOsae = (s) => String(s).replace(OSAE_STRIP_RE, '');

test('(抑え…) 付き文字列が本線だけになる（大井6R・船橋5R）', () => {
  assert.strictEqual(stripOsae('11↔2.4.5.7.13(抑え3.6.8.10.12.14)'), '11↔2.4.5.7.13');
  assert.strictEqual(stripOsae('1↔2.5.6.7.9(抑え4.8.10)'), '1↔2.5.6.7.9');
  assert.strictEqual(stripOsae('7↔2.4.5.11.13(抑え3.6.8.10.12.14)'), '7↔2.4.5.11.13');
});

test('全角括弧「（抑え…）」形式も除去', () => {
  assert.strictEqual(stripOsae('9↔1.2.3.5.8（抑え4.6.7）'), '9↔1.2.3.5.8');
});

test('抑えなし文字列は不変・区切り記号(dash/↔/⇔/→)は保持', () => {
  assert.strictEqual(stripOsae('5↔1.2.3.4'), '5↔1.2.3.4');
  assert.strictEqual(stripOsae('6-11.9.13.10.7'), '6-11.9.13.10.7');   // dash 保持
  assert.strictEqual(stripOsae('5⇔9.11.6.8.4'), '5⇔9.11.6.8.4');       // ⇔ 保持
  assert.strictEqual(stripOsae('4→8.4.7.5.3'), '4→8.4.7.5.3');         // → 保持
  assert.strictEqual(stripOsae('13↔2.3.9.10.14'), '13↔2.3.9.10.14');
});

test('Premium南関・JRA はコードと同一の抑え除去正規表現を表示専用に持つ', () => {
  for (const p of ['../pages/premium-prediction/nankan.astro', '../pages/premium-prediction/jra.astro']) {
    const s = src(p);
    assert.ok(s.includes('[(（]抑え[^)）]*[)）]'), `${p} が想定の抑え除去正規表現を持たない`);
    assert.ok(s.includes('stripOsaeForDisplay'), `${p} が stripOsaeForDisplay を定義していない`);
    assert.ok(/numbers:\s*stripOsaeForDisplay\(/.test(s), `${p} が表示 numbers に抑え除去を適用していない`);
  }
});

test('Premium表示は保存文字列を破壊しない（点数は元の行から算出・bettingLines再代入なし）', () => {
  for (const p of ['../pages/premium-prediction/nankan.astro', '../pages/premium-prediction/jra.astro']) {
    const s = src(p);
    // 点数は原文字列(line/lineStr)から算出（抑え除去後の値では算出しない）
    assert.ok(/countPointsFromUmatanLine\((line|lineStr)\)/.test(s), `${p} の点数算出が原文字列でない`);
    // 保存 bettingLines.umatan への代入・書き換えをしていない
    assert.ok(!/bettingLines\.umatan\s*=/.test(s), `${p} が保存 bettingLines.umatan を書き換えている`);
  }
});

// ── Premium から「馬単10点」バッジ / 右端「N点」バッジ / 「…10点構成です」注記を非表示 ──
test('Premium南関・JRA に「馬単10点」バッジ・「10点構成です」注記が残っていない', () => {
  for (const p of ['../pages/premium-prediction/nankan.astro', '../pages/premium-prediction/jra.astro']) {
    const s = src(p);
    // 「馬単10点」チップと「…10点構成です」注記の本文を削除（unified-bet-subtitle/note クラス自体は
    //  三連複カードが共用するため存在は許容。馬単固有のテキストが消えていることで判定する）。
    assert.ok(!s.includes('馬単10点'), `${p} に「馬単10点」表記が残存`);
    assert.ok(!s.includes('10点構成です'), `${p} に「10点構成です」注記が残存`);
  }
});

test('Premium馬単 bet-item に点数バッジ(bet-points)を表示していない', () => {
  for (const p of ['../pages/premium-prediction/nankan.astro', '../pages/premium-prediction/jra.astro']) {
    const s = src(p);
    // 馬単の bet-item 内に <span class="bet-points">…点</span> を出していない
    // （三連複カードは対象外だが、馬単側の points バッジ記述が消えていることを確認）
    assert.ok(!/bet-points">\{(bet|ln)\.points\}点/.test(s), `${p} の馬単に点数バッジが残存`);
  }
});
