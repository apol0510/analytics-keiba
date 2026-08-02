/**
 * adminMultiFilterUi.guard.test.mjs
 *
 * 管理画面の「チェック式 複数選択フィルター」が壊れていないことを、
 * ページのソースそのものに対して検査する。
 *
 * なぜ source 検査か: この画面の絞り込みは `<script is:inline>` の中にあり、
 * import できない。過去、単一 select へ戻す差分や、配列送信を単一値へ戻す差分が
 * 気づかれずに入ったため、**形が戻ったら落ちる**検査を置く。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(path.join(HERE, '../../pages/admin/premium-plus-eligibility.astro'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script is:inline>'));
const STYLE = PAGE.slice(PAGE.indexOf('<style is:global>'), PAGE.indexOf('</style>'));
const FN_CB = readFileSync(path.join(HERE, '../../../netlify/functions/admin-comeback-grants.js'), 'utf8');
const FN_MK = readFileSync(path.join(HERE, '../../../netlify/functions/admin-marketing.js'), 'utf8');

test('guard(filter): 判定は単一源（adminMultiFilter.js）へ橋渡ししている', () => {
  assert.match(PAGE, /from '\.\.\/\.\.\/lib\/marketing\/adminMultiFilter\.js'/, '単一源を import していない');
  assert.match(PAGE, /window\.__mkFilter = \{/, '橋渡しが無い');
  for (const fn of ['countApplied', 'buildChips', 'describeConditions', 'summarizeSelection', 'isActiveMemberIncluded']) {
    assert.match(PAGE, new RegExp(fn), `${fn} を橋渡ししていない`);
  }
});

test('guard(filter): 複数選択コンポーネントがある（単一 select へ戻していない）', () => {
  assert.match(SCRIPT, /function makeMultiFilter\(/, '複数選択コンポーネントが無い');
  assert.match(SCRIPT, /type = 'checkbox'/, 'チェック式になっていない');
  assert.match(SCRIPT, /aria-expanded/, '開閉状態を伝えていない');
  assert.match(SCRIPT, /aria-controls/, 'ボタンとパネルを結びつけていない');
  assert.match(SCRIPT, /e\.key === 'Escape'/, 'Esc で閉じられない');
});

test('guard(filter): カムバックの 6 項目すべてを複数選択にしている', () => {
  for (const id of ['cbContract', 'cbPlan', 'cbWithdrawn', 'cbPromo', 'cbGrantable', 'cbHistory']) {
    assert.match(SCRIPT, new RegExp(`'${id}'`), `${id} が複数選択の対象に無い`);
  }
  assert.match(SCRIPT, /const CB_MULTI_IDS = \[/, 'カムバックの項目一覧が無い');
});

test('guard(filter): マーケティングの 9 項目すべてを複数選択にしている', () => {
  const ids = ['mkContract', 'mkPlan', 'mkSendable', 'mkPp', 'mkHistory',
    'mkOfferState', 'mkPromoState', 'mkFrequency', 'mkLastLogin'];
  const block = SCRIPT.slice(SCRIPT.indexOf('const MK_MULTI_IDS'));
  for (const id of ids) assert.match(block, new RegExp(`'${id}'`), `${id} が複数選択の対象に無い`);
});

test('guard(filter): 取得は配列で送る（単一値へ戻していない）', () => {
  assert.match(SCRIPT, /contract: sel\.cbContract/, 'カムバックが配列を送っていない');
  assert.match(SCRIPT, /contract: sel\.mkContract/, 'マーケティングが配列を送っていない');
  assert.equal(/contract: \$\('cbContract'\)\.value/.test(SCRIPT), false, '単一値送信が残っている');
  assert.equal(/contract: \$\('mkContract'\)\.value/.test(SCRIPT), false, '単一値送信が残っている');
});

test('guard(filter): 既定は「期限切れ・退会済み・休眠」で現有効会員を含めない', () => {
  assert.match(SCRIPT, /setValues\(\[\.\.\.filterApi\(\)\.CB_SEGMENT_DEFAULT\]\)/, '既定値を設定していない');
  assert.match(SCRIPT, /isActiveMemberIncluded\(selections\.cbContract\)/, '現有効会員の混入を検知していない');
  assert.match(SCRIPT, /ACTIVE_FILTER_WARNING/, '警告文を出していない');
});

test('guard(filter): プリセットはボタン（選択肢に「すべて」を混ぜない）', () => {
  assert.match(PAGE, /id="cbPresets"/, 'プリセットの置き場所が無い');
  assert.match(SCRIPT, /CB_SEGMENT_PRESETS/, 'プリセットを使っていない');
  // 「すべて」相当はチェック項目にしない（0 件＝条件なし）
  assert.match(SCRIPT, /o\.value !== 'all' && o\.value !== 'candidates'/, '「すべて」を選択肢から外していない');
});

test('guard(filter): 適用中の条件をチップで出し、1 件ずつ外せる', () => {
  assert.match(PAGE, /id="cbChips"/, 'カムバックのチップ置き場が無い');
  assert.match(PAGE, /id="mkChips"/, 'マーケティングのチップ置き場が無い');
  assert.match(SCRIPT, /function cbRenderChips\(/, 'チップを描いていない');
  assert.match(SCRIPT, /function mkRenderChips\(/, 'チップを描いていない');
  assert.match(SCRIPT, /st\.selected\.filter\(\(v\) => v !== c\.value\)/, 'チップ 1 件を外せない');
  assert.match(SCRIPT, /条件をすべてクリア/, '一括クリアが無い');
});

test('guard(filter): 論理（同項目 OR / 項目間 AND）を画面に書いている', () => {
  assert.match(PAGE, /id="cbLogicNote"/, 'カムバックの説明欄が無い');
  assert.match(PAGE, /id="mkLogicNote"/, 'マーケティングの説明欄が無い');
  assert.match(SCRIPT, /FILTER_LOGIC_NOTE/, '説明文を出していない');
});

test('guard(filter): メニューの操作性（幅・行高・最大高）を満たす', () => {
  const panel = STYLE.slice(STYLE.indexOf('.mfilter-panel'));
  assert.match(panel, /min-width: 260px/, 'メニュー幅が狭い');
  assert.match(panel, /max-height: 320px/, '最大高が無い');
  const row = STYLE.slice(STYLE.indexOf('.mfilter-row {'));
  assert.match(row, /min-height: 44px/, '行が押しにくい');
  assert.match(STYLE, /focus-visible/, 'キーボード操作の枠が無い');
});

test('guard(filter): 右端のメニューは右揃えにして画面外へ出さない', () => {
  // 1280px 幅の実機で mkSendable のメニューが画面外へ出ていた（2026-08-02 目視確認で検出）
  assert.match(SCRIPT, /panel\.classList\.add\('is-right'\)/, '右揃えへの切り替えが無い');
  assert.match(SCRIPT, /window\.innerWidth/, '画面幅を見ていない');
  assert.match(STYLE, /\.mfilter-panel\.is-right \{ left: auto; right: 0; \}/, '右揃えの見た目が無い');
  assert.match(STYLE, /max-width: calc\(100vw - 1\.5rem\)/, '画面幅を超えないようにしていない');
});

test('guard(filter): 初期表示でも現在の Step が分かる', () => {
  // マーケティングタブは同期が走るまで Step が無色のままだった
  assert.match(SCRIPT, /mkInitFilters\(\);\s*\n\s*\/\/[^\n]*\n\s*mkSyncFlow\(\);/, '初期表示で Step を同期していない');
  assert.match(SCRIPT, /cbSync\(\);\s*\n\s*\} catch/, '初期表示で Step を同期していない');
});

test('guard(filter): 絞り込みは折り返す（横スクロールを作らない）', () => {
  const mobile = STYLE.slice(STYLE.indexOf('@media (max-width: 900px)'));
  assert.equal(/overflow-x:\s*(auto|scroll)/.test(mobile), false, '横スクロールを作っている');
  assert.match(mobile, /\.ppe \.toolbar > \* \{ flex: 1 1 100%/, 'スマホで 1 列になっていない');
});

test('guard(filter): Step の現在地は色だけでなくバッジと「Step n / N」で示す', () => {
  assert.match(PAGE, /id="cbProgress"/, 'カムバックの進捗表示が無い');
  assert.match(PAGE, /id="mkProgress"/, 'マーケティングの進捗表示が無い');
  assert.match(SCRIPT, /'Step ' \+ step \+ ' \/ 5'/, 'カムバックの進捗を更新していない');
  assert.match(SCRIPT, /'Step ' \+ step \+ ' \/ 6'/, 'マーケティングの進捗を更新していない');
  assert.match(SCRIPT, /step-now-badge/, '現在地バッジが無い');
  assert.match(STYLE, /\.step-now-badge/, 'バッジの見た目が無い');
});

test('guard(filter): 追従バーに今の条件を出す', () => {
  assert.match(PAGE, /id="cbSbCond"/, '条件表示が無い');
  assert.match(SCRIPT, /条件が変更されています/, '条件変更を知らせていない');
});

test('guard(api): 許可値以外は 400（formula へ直結させない）', () => {
  assert.match(FN_CB, /validateSelection/, 'カムバックが検証していない');
  assert.match(FN_MK, /validateSelection/, 'マーケティングが検証していない');
  assert.match(FN_CB, /CB_FILTER_ALLOW/, '許可値の定義が無い');
  assert.match(FN_MK, /MK_FILTER_ALLOW/, '許可値の定義が無い');
  assert.match(FN_CB, /return json\(400, \{ error: v\.error \}\)/, '未知の値を 400 にしていない');
  assert.match(FN_MK, /return json\(400, \{ error: v\.error \}\)/, '未知の値を 400 にしていない');
  // 受け取った値をそのまま Airtable の formula に入れない
  assert.equal(/filterByFormula[^\n]*req\./.test(FN_CB), false, 'リクエスト値を formula に直結している');
  assert.equal(/filterByFormula[^\n]*req\./.test(FN_MK), false, 'リクエスト値を formula に直結している');
});
