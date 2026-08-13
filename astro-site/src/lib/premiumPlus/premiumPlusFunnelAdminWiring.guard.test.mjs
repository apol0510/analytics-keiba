/**
 * premiumPlusFunnelAdminWiring.guard.test.mjs — 実閲覧の運用 UI が**画面まで通っている**
 *   node --test src/lib/premiumPlus/premiumPlusFunnelAdminWiring.guard.test.mjs
 *
 * 判定（premiumPlusFunnelAnalytics.js）が正しくても、Function が返さなければ、
 * あるいは画面が描かなければ運用者には何も見えない。配線を静的に押さえる。
 *
 * 併せて、この機能で**絶対に破ってはいけない 4 つ**を固定する:
 *   1. 未計測を 0 回と書かない
 *   2. 個人情報を Redis へ増やさない
 *   3. 全件走査を作らない・部分取得は fail closed
 *   4. 30 分重複除外・未認証 / bot / 管理者プレビュー除外を維持
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PAGE = read('../../pages/admin/premium-plus-eligibility.astro');
const FN = read('../../../netlify/functions/premium-plus-eligibility.js');
const STORE = read('./premiumPlusFunnelStore.js');
const SERVER = read('./premiumPlusFunnelServer.js');
const API = read('../../pages/api/pp-funnel.json.js');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const PAGEC = strip(PAGE);
const FNC = strip(FN);

// ── Function 側 ────────────────────────────────────────────
test('【重要】list と lookup の両方が転換サマリを返す', () => {
  assert.match(FNC, /summarizeFunnel\(rows\)/);
  const returns = FNC.match(/^\s*funnel,$/gm) || [];
  assert.ok(returns.length >= 2, `funnel を返す経路が ${returns.length}（list と lookup の 2 つが必要）`);
});

test('【重要】行に段階と最終反応時刻を載せる（判定は単一源に委ねる）', () => {
  assert.match(FNC, /resolveFunnelStage\(/);
  assert.match(FNC, /lastReactionAtMs\(/);
  assert.match(FNC, /r\.funnelStage = /);
  assert.match(FNC, /r\.lastReactionAtMs = /);
});

test('【重要】読めなかったときも段階を「未確認」にする（未表示にしない）', () => {
  const un = FNC.slice(FNC.indexOf('const unavailable = (reason)'));
  const body = un.slice(0, un.indexOf('};'));
  assert.match(body, /available: false/);
  assert.match(body, /funnelStage/);
  assert.match(body, /lastReactionAtMs = null/);
});

// ── 画面側 ────────────────────────────────────────────────
test('【重要】段階での絞り込みがある（選択肢はモジュール定義から作る）', () => {
  assert.match(PAGE, /id="fFunnel"/);
  assert.match(PAGEC, /FUNNEL_STAGE_ORDER/);
  assert.match(PAGEC, /filterByStage\(/);
  assert.ok(!/value="viewed_not_clicked"/.test(PAGE), '選択肢を画面へベタ書きしている（段階追加を取りこぼす）');
});

test('【重要】反応が新しい順に並べ替えできる', () => {
  assert.match(PAGE, /id="fSort"/);
  assert.match(PAGEC, /sortByLastReaction\(rows\)/);
});

test('【重要】表示・クリック・到達それぞれの回数と初回・最終を出す', () => {
  assert.match(PAGEC, /cell\.count/);
  assert.match(PAGEC, /cell\.firstAtJst/);
  assert.match(PAGEC, /cell\.lastAtJst/);
  assert.match(PAGEC, /\['cta', '表示'\], \['click', 'クリック'\], \['page', '商品ページ'\]/);
});

test('【重要】未実測に日時や回数を出さない（measured を必ず見る）', () => {
  const cellFn = PAGEC.slice(PAGEC.indexOf('function realViewCell'));
  const body = cellFn.slice(0, cellFn.indexOf('\n    }'));
  assert.match(body, /if \(cell\.measured\)/);
  assert.match(body, /未確認/);
  assert.ok(!/`\$\{label\} 0 回`/.test(body), '0 回と書いている');
});

test('【重要】転換率は分母が確定しないとき「未確定」（0% と書かない）', () => {
  assert.match(PAGEC, /function renderFunnelBar/);
  assert.match(PAGEC, /rate === null \? `\$\{rateLabel\} 未確定`/);
  assert.match(PAGEC, /renderFunnelBar\(data\.truncated \? null : \(data\.funnel \|\| null\)\)/);
});

test('【重要】表示→クリック→到達の順で人数を出す', () => {
  const bar = PAGEC.slice(PAGEC.indexOf('function renderFunnelBar'));
  const iView = bar.indexOf("step('表示'");
  const iClick = bar.indexOf("step('クリック'");
  const iReach = bar.indexOf("step('商品ページ到達'");
  assert.ok(iView >= 0 && iClick > iView && iReach > iClick, '順序が 表示 → クリック → 到達 になっていない');
});

test('【重要】新規反応の基準はブラウザだけが持つ（サーバー・Redis へ保存しない）', () => {
  assert.match(PAGEC, /sessionStorage\.(getItem|setItem)\('ppFunnelSeenAt'|FUNNEL_SEEN_KEY/);
  assert.match(PAGEC, /isNewReaction\(/);
  // 基準時刻を API へ送っていないこと
  assert.ok(!/seenAt/.test(FNC), 'サーバーが新規反応の基準を持ってしまっている');
});

test('新規反応は手動の再読み込みでだけ既読になる（自動更新で消さない）', () => {
  assert.match(PAGEC, /if \(!auto\) markFunnelSeen\(\)/);
});

// ── 自動更新 ───────────────────────────────────────────────
test('【重要】自動更新は安全な間隔・条件でだけ動く', () => {
  assert.match(PAGEC, /const AUTO_REFRESH_MS = (\d+)/);
  const ms = Number(/const AUTO_REFRESH_MS = (\d+)/.exec(PAGEC)[1]);
  assert.ok(ms >= 60000, `更新間隔が短すぎる（${ms}ms）`);
  const tick = PAGEC.slice(PAGEC.indexOf('function autoRefreshTick'));
  const body = tick.slice(0, tick.indexOf('\n    }'));
  assert.match(body, /visibilityState !== 'visible'/, '背景タブでも叩いている');
  assert.match(body, /dtRecordId/, '詳細を開いている間も更新している');
  assert.match(body, /autoBusy/, '実行が重なる');
  assert.match(body, /secret/, 'シークレット未入力でも叩いている');
});

test('【重要】更新日時を表示する', () => {
  assert.match(PAGE, /id="refreshNote"/);
  assert.match(PAGEC, /function renderRefreshNote/);
  assert.match(PAGEC, /最終更新/);
});

test('自動更新は画面のメッセージを上書きしない', () => {
  assert.match(PAGEC, /async function call\(payload, opt\)/);
  assert.match(PAGEC, /const quiet = !!\(opt && opt\.quiet\)/);
  assert.match(PAGEC, /\{ quiet: auto \}/);
});

// ── 個別検索でも同じ情報 ────────────────────────────────────
test('【重要】個別検索（詳細）でも段階と回数・初回・最終を出す', () => {
  const d = PAGEC.slice(PAGEC.indexOf('function renderDetail'));
  const body = d.slice(0, d.indexOf('info.appendChild(dl)') + 30);
  assert.match(body, /実閲覧 段階/);
  assert.match(body, /実閲覧 \$\{label\}/);
  assert.match(body, /c\.measured/);
  assert.match(body, /'未確認'/);
});

// ── 破ってはいけない前提が残っていること ──────────────────────
test('【重要】30 分の重複除外を維持している', () => {
  assert.match(STORE, /DEDUPE_MS/);
  const m = /DEDUPE_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/.exec(STORE);
  assert.ok(m, 'DEDUPE_MS の定義が読めない');
  assert.equal(Number(m[1]), 30, `重複除外が ${m[1]} 分になっている`);
});

test('【重要】未認証 / bot / 管理者プレビューの除外を維持している', () => {
  assert.match(STORE, /authenticated/);
  assert.match(STORE, /adminPreview/);
  assert.match(STORE, /userAgent/);
  assert.match(SERVER, /isAdminPreviewRequest/);
  // 記録 API は未ログインで 404（存在秘匿）
  assert.match(API, /404/);
});

test('【重要】Redis へ個人情報を増やしていない', () => {
  const code = strip(STORE);
  for (const bad of ['Email', 'email', '氏名', 'RecipientEmail']) {
    assert.ok(!new RegExp(`\\b${bad}\\b`).test(code), `Redis 層が個人情報を扱っている: ${bad}`);
  }
  // 鍵は recordId 形式のみ
  assert.match(STORE, /RECORD_ID_RE/);
});

test('【重要】全件走査を作っていない・部分取得は fail closed', () => {
  // 実閲覧は recordId を名指しで読む（HMGET）。無条件の SCAN/KEYS を使わない
  assert.ok(!/'SCAN'|'KEYS'/.test(STORE), 'Redis の全件走査を使っている');
  assert.match(STORE, /HMGET/);
  // 読めなければ available:false（0 件として返さない）
  assert.match(STORE, /available: false/);
  const fn = FNC.slice(FNC.indexOf('async function attachRealViews'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /return unavailable\(/);
});

// ══════════════════════════════════════════════════════════════
//  CTA の導線（クリック元）の配線
// ══════════════════════════════════════════════════════════════
const TEASER = read('../../components/PremiumPlusStageTeaser.astro');
const DASH = read('../../pages/dashboard.astro');
const PPV2 = read('../../pages/premium-plus-v2.astro');
const PP = read('../../pages/premium-plus.astro');
const CLIENT = read('./premiumPlusFunnelClient.js');

test('【重要】source はサーバーの allow-list で検証する（クライアント任意値を保存しない）', () => {
  assert.match(API, /normalizeFunnelSource\(body\.source\)/);
  assert.match(API, /source,/);
  // クライアント側で検証して「通ったから安全」にしていないこと
  assert.ok(!/ALLOWED_SOURCES|SOURCE_SET/.test(CLIENT), 'クライアントが採否を判断している');
});

test('【重要】三連複ページの案内枠は sanrenpuku を送る', () => {
  assert.match(TEASER, /event: 'cta_view', el: card, source: 'sanrenpuku'/);
  assert.match(TEASER, /event: 'cta_click', source: 'sanrenpuku'/);
  assert.match(TEASER, /from=sanrenpuku/);
});

test('【重要】dashboard の「会員限定のご案内を見る」は dashboard を送る', () => {
  assert.match(DASH, /event: 'cta_view', el: section, source: 'dashboard'/);
  assert.match(DASH, /event: 'cta_click', source: 'dashboard'/);
  assert.match(DASH, /from=dashboard/);
});

test('【重要】商品ページ到達も導線を allow-list 経由で記録する', () => {
  for (const [name, src] of [['premium-plus-v2', PPV2], ['premium-plus', PP]]) {
    assert.match(src, /readPlusSourceFromUrl\(Astro\.url\)/, `${name} が導線を読んでいない`);
  }
  assert.match(SERVER, /export function readPlusSourceFromUrl/);
  assert.match(SERVER, /normalizeFunnelSource\(u\.searchParams\.get\('from'\)\)/);
});

test('【重要】重複除外は合計の lastAt だけで判断する（内訳が合計を超えない）', () => {
  const rec = STORE.slice(STORE.indexOf('async record('));
  const body = rec.slice(0, rec.indexOf('async read('));
  assert.match(body, /const lastAt = num\(cur\.lastAt\)/);
  assert.match(body, /now - lastAt < DEDUPE_MS/);
  // 導線ごとに別の dedupe を持っていないこと
  assert.ok(!/bySource\[[^\]]+\]\.lastAt[\s\S]{0,80}DEDUPE_MS/.test(body), '導線ごとに重複除外している');
});

test('【重要】導線不明を推測で振り分けない', () => {
  // 合計 - 内訳 が unknownCount。マッピングや既定値で dashboard へ寄せていないこと
  assert.match(STORE, /const unknownCount = Math\.max\(0, count - known\)/);
  assert.ok(!/source \|\| 'dashboard'|source \?\? 'dashboard'/.test(STORE), '既定値で dashboard に寄せている');
  assert.ok(!/source \|\| 'sanrenpuku'/.test(STORE), '既定値で sanrenpuku に寄せている');
});

test('【重要】管理画面が導線別の内訳と「不明」を出す', () => {
  assert.match(PAGEC, /cell\.sources/);
  assert.match(PAGEC, /cell\.unknownCount > 0/);
  assert.match(PAGEC, /cell\.unknownLabel/);
  assert.match(PAGEC, /funnel\.bySource/);
  assert.match(PAGEC, /funnel\.unknownSource/);
});

test('【重要】詳細（個別検索）でも導線別を出す', () => {
  const d = PAGEC.slice(PAGEC.indexOf('function renderDetail'));
  const body = d.slice(0, d.indexOf('info.appendChild(dl)') + 30);
  assert.match(body, /c\.sources/);
  assert.match(body, /c\.unknownLabel/);
});

test('【重要】導線を増やしても画面がベタ書きにならない', () => {
  assert.match(PAGEC, /funnel\.bySource \|\| \[\]/);
  assert.ok(!/'ダッシュボード'|'三連複ページ'/.test(PAGEC), '導線名を画面へベタ書きしている');
});

test('【重要】Redis へ個人情報を増やしていない（導線追加後も）', () => {
  const code = strip(STORE);
  for (const bad of ['Email', 'email', '氏名', 'referrer', 'Referer']) {
    assert.ok(!new RegExp(`\\b${bad}\\b`).test(code), `Redis 層が扱ってはいけない値: ${bad}`);
  }
});
