/**
 * pageGuards.test.mjs — premium-prediction/{nankan,jra}.astro が三連複 段階表示へ
 * 正しく配線され、旧5日ゲートの残骸や JRA 結果セクション新設が無いことを固定する静的 guard。
 *   node --test src/lib/sanrenpuku/pageGuards.test.mjs
 *
 * DOM を評価せず、ソース文字列を検査する（prbFunctionGuards.test.mjs と同型）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd(); // astro-site
const nankan = readFileSync(join(root, 'src/pages/premium-prediction/nankan.astro'), 'utf8');
const jra = readFileSync(join(root, 'src/pages/premium-prediction/jra.astro'), 'utf8');

test('両ページが単一源 sanrenpukuCtaStage を import して planSanrenpukuDisplay を使う', () => {
  for (const [name, src] of [['nankan', nankan], ['jra', jra]]) {
    assert.match(src, /from ['"]\.\.\/\.\.\/lib\/sanrenpuku\/sanrenpukuCtaStage\.js['"]/, `${name}: helper import 無し`);
    assert.match(src, /planSanrenpukuDisplay\(/, `${name}: planSanrenpukuDisplay 呼び出し無し`);
    assert.match(src, /isFunnelTarget\(/, `${name}: isFunnelTarget 呼び出し無し`);
    assert.match(src, /hasResultSection:/, `${name}: hasResultSection 未指定`);
  }
});

test('旧5日ゲート（5 * 24 * 60 * 60 * 1000 / GRACE_MS）が両ページから除去されている', () => {
  for (const [name, src] of [['nankan', nankan], ['jra', jra]]) {
    assert.ok(!/5 \* 24 \* 60 \* 60 \* 1000/.test(src), `${name}: 旧5日 GRACE_MS が残存`);
    assert.ok(!/GRACE_MS/.test(src), `${name}: GRACE_MS が残存`);
  }
});

test('予告カード要素が両ページに存在する（南関/JRA で id 別）', () => {
  assert.match(nankan, /id="sanrenpuku-teaser-section"/, 'nankan 予告カード id 無し');
  assert.match(jra, /id="sanrenpuku-teaser-section-jra"/, 'jra 予告カード id 無し');
  assert.match(nankan, /srp-teaser-day2/, 'nankan day2 body 無し');
  assert.match(jra, /srp-teaser-day2/, 'jra day2 body 無し');
});

test('day3（予告＋結果）ボディは南関・JRA 双方に存在する（中央・南関で3日目対称）', () => {
  assert.match(nankan, /srp-teaser-day3/, 'nankan day3 body 無し');
  assert.match(jra, /srp-teaser-day3/, 'jra day3 body 無し（JRA 結果セクション新設に伴い追加）');
});

test('JRA に三連複的中結果セクションを新設し、getLatestSanrenpukuDayDataJra を使う（既定は非表示）', () => {
  assert.match(jra, /id="sanrenpuku-yesterday-results"/, 'jra に結果セクションが無い');
  assert.match(nankan, /id="sanrenpuku-yesterday-results"/, 'nankan 結果セクションが消えている');
  assert.match(jra, /getLatestSanrenpukuDayDataJra/, 'jra が JRA 用データ取得関数を使っていない');
  assert.match(jra, /id="sanrenpuku-yesterday-results" style="display: none;"/, 'jra 結果セクションが既定表示になっている（未購入 Premium の3日目以降のみ表示すべき）');
});

test('JRA 結果は funnel（未購入 Premium）限定・段階ゲート経由でのみ表示＝購入済み/無料/未ログインに出さない', () => {
  // funnel 対象外は早期 return。結果表示は view.showResult（helper が購入済み=false を保証）でのみ発火。
  assert.match(jra, /if \(!isFunnelTarget\(planRaw\)\) return;/, 'jra コントローラに funnel 早期 return が無い');
  assert.match(jra, /resultEl && view\.showResult/, 'jra 結果表示が段階ゲート（view.showResult）を経由していない');
  // JRA には結果をプラン直判定で無条件表示するゲートを設けない
  assert.ok(!/userPlan === 'Premium Sanrenpuku'/.test(jra), 'jra に購入済みへ結果を出すプラン直ゲートが混入している');
});

test('南関の下部結果ゲートは馬単のみ Premium を先出ししない（旧 broad OR 行を除去）', () => {
  assert.ok(
    !/userPlan === 'Premium' \|\| userPlan === 'premium' \|\|/.test(nankan),
    'nankan 下部ゲートに Premium/premium の先出し行が残存（1〜2日目に結果だけ出る）',
  );
});

test('三連複購入済みユーザーに的中結果の先行表示をしない（結果ゲートが Premium Sanrenpuku を show しない）', () => {
  // 結果ゲートは変数 userPlan で判定する。`userPlan === 'Premium Sanrenpuku'` が残っていれば
  // 購入済みに先行結果を出している（売る導線を出さない方針に反する）。
  // ※ 買い目セクションの権利判定は別変数 `plan === 'Premium Sanrenpuku'` で行い、こちらは維持する。
  assert.ok(
    !/userPlan === 'Premium Sanrenpuku'/.test(nankan),
    'nankan 結果ゲートが購入済み Premium Sanrenpuku に先行結果を表示している',
  );
});

test('×閉じ（ak-srp-cta-dismissed）と初回時刻（ak-umatan-first-seen）の扱いを維持', () => {
  for (const [name, src] of [['nankan', nankan], ['jra', jra]]) {
    assert.match(src, /ak-srp-cta-dismissed/, `${name}: dismiss キー無し`);
    assert.match(src, /ak-umatan-first-seen/, `${name}: 初回時刻キー無し`);
  }
});
