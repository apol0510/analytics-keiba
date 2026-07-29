/**
 * adminUiGuard.test.mjs — Premium Plus 販売管理画面（/admin/premium-plus-eligibility/）の UI 契約
 *   node --test src/lib/premiumPlus/adminUiGuard.test.mjs
 *
 * UI 再設計で **write 契約 / preview 契約 / 安全機構 / スタイル適用**が壊れていないことを固定する。
 * （画面は prerender=true の静的ページなので、配信 HTML/JS = このソースそのもの）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE_URL = new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url);
const PAGE = readFileSync(fileURLToPath(PAGE_URL), 'utf8');
const STYLE = PAGE.slice(PAGE.indexOf('<style is:global>'), PAGE.indexOf('</style>'));
const SCRIPT = PAGE.slice(PAGE.indexOf('<script is:inline>'));

// ── API 契約（UI を変えても payload を変えない）──────────────────
test('write payload が変わっていない（action/update の 4 キー）', () => {
  assert.match(PAGE, /call\(\{\s*action:\s*'update',\s*recordId:\s*r\.recordId,\s*plusAction,\s*reason:\s*memoInput\.value\s*\}\)/);
  for (const a of ["'staged'", "'immediate'", "'review'", "'blocked'"]) {
    assert.ok(PAGE.includes(a), `plusAction が無い: ${a}`);
  }
});

test('list / preview の payload が変わっていない', () => {
  assert.match(PAGE, /action:\s*'list',\s*onlyReview:/);
  assert.match(PAGE, /action:\s*'preview',[\s\S]{0,200}?recordId:\s*pvRecordId/);
  assert.match(PAGE, /atMin:\s*\$\('pvTime'\)\.value === '' \? null : Number/);
  assert.match(PAGE, /phaseDaysAgo:\s*\$\('pvPhase'\)\.value === '' \? null : Number/);
});

test('管理者認証（x-admin-secret）と secret の非表示を維持', () => {
  assert.match(PAGE, /'x-admin-secret':\s*secret/);
  assert.match(PAGE, /type="password"\s+id="secret"/);
  assert.doesNotMatch(PAGE, /textContent\s*=\s*secret/);
  assert.doesNotMatch(PAGE, /innerHTML[^\n]*secret/);
});

// ── 安全機構 ─────────────────────────────────────────────────────
test('「今すぐ販売可」の確認ダイアログを維持', () => {
  assert.match(PAGE, /window\.confirm\(/);
  assert.match(PAGE, /この会員は即時PHASE 4となり、価格と購入CTAが表示されます。/);
  assert.match(PAGE, /if \(plusAction === 'immediate'\)\s*\{[\s\S]{0,120}window\.confirm/);
});

test('二重送信防止を維持（busy フラグ + 行内ボタン一括 disable）', () => {
  assert.match(PAGE, /dataset\.busy === '1'\) return/);
  assert.match(PAGE, /buttons\.forEach\(\(x\) => \{ x\.disabled = true; \}\)/);
});

test('fail closed: 書込 gate が無効ならボタンを押せない', () => {
  assert.match(PAGE, /btn\.disabled = !data\.writeEnabled \|\| isCurrent \|\| !!extraDisabled/);
  assert.match(PAGE, /mkBtn\('immediate',[^)]*!data\.overrideEnabled\)/);
});

// ── 一覧はテーブル。write ボタンを露出させない ───────────────────
test('一覧は 8 列のテーブル', () => {
  for (const th of ['顧客', '状態', 'プラン', 'Route', 'PHASE', '販売許可日', '最終更新', '操作']) {
    assert.ok(PAGE.includes('>' + th + '</th>'), `列が無い: ${th}`);
  }
  assert.match(PAGE, /<tbody id="rows">/);
  assert.match(PAGE, /\$\('rows'\)/);
});

test('一覧の各行には「詳細・操作」ボタンだけを置く（write ボタンを出さない）', () => {
  const iRender = SCRIPT.indexOf('function render()');
  const iDetail = SCRIPT.indexOf('function renderDetail()');
  assert.ok(iRender >= 0 && iDetail > iRender, 'render / renderDetail の順序が想定と違う');
  const listPart = SCRIPT.slice(iRender, iDetail);
  assert.match(listPart, /btn\.className = 'btn-detail'/);
  assert.match(listPart, /openDetail\(r\.recordId\)/);
  // 一覧側に write 系の生成が無い
  assert.doesNotMatch(listPart, /mkBtn\(/, '一覧に操作ボタンを描画している');
  assert.doesNotMatch(listPart, /action: 'update'/, '一覧から write できる');
  assert.doesNotMatch(listPart, /window\.confirm/);
});

test('write は詳細パネル内だけで行う', () => {
  const iDetail = SCRIPT.indexOf('function renderDetail()');
  const detailPart = SCRIPT.slice(iDetail);
  assert.match(detailPart, /action: 'update'/);
  // update を発火する箇所はこの 1 か所だけ
  assert.equal((SCRIPT.match(/action: 'update'/g) || []).length, 1);
});

// ── 状態バッジ ───────────────────────────────────────────────────
test('状態バッジ 5 種（短いラベル）と分類ロジックがある', () => {
  for (const k of ['review', 'staged', 'sale', 'immediate', 'blocked']) {
    assert.ok(STYLE.includes(`.badge.${k}`), `バッジ CSS が無い: ${k}`);
  }
  assert.match(PAGE, /function classify\(r\)/);
  assert.match(PAGE, /short: '保留'/);
  assert.match(PAGE, /short: 'PHASE ' \+ r\.phase/);
  assert.match(PAGE, /short: '販売中'/);
  assert.match(PAGE, /short: '即時販売'/);
  assert.match(PAGE, /short: '販売対象外'/);
  // 一覧では短いバッジ（長文の「段階公開中 PHASE 1」を一覧に出さない）
  assert.doesNotMatch(PAGE, /'段階公開中 PHASE '/);
});

test('分類は eligibility → override → phase の順（サーバ判定に追従）', () => {
  assert.match(PAGE, /if \(r\.eligibility === 'blocked'\)/);
  assert.match(PAGE, /if \(r\.eligibility !== 'eligible'\)/);
  assert.match(PAGE, /if \(r\.overrideApplied\)/);
  assert.match(PAGE, /if \(r\.phase === 4\)/);
});

// ── 検索・フィルター ─────────────────────────────────────────────
test('状態フィルター 5 種 + Route フィルター + Email 検索（クライアント側のみ）', () => {
  for (const v of ['all', 'review', 'eligible', 'immediate', 'blocked']) {
    assert.ok(PAGE.includes(`<option value="${v}">`), `状態フィルターが無い: ${v}`);
  }
  assert.ok(PAGE.includes('<option value="sanrenpuku">'));
  assert.ok(PAGE.includes('<option value="premium_30d">'));
  assert.match(PAGE, /id="q"[^>]*placeholder="Email で検索"/);
  assert.match(PAGE, /String\(r\.email \|\| ''\)\.toLowerCase\(\)\.includes\(q\)/);
  // 再描画のみ。API を呼ばない
  assert.match(PAGE, /\$\('q'\)\.addEventListener\('input', render\)/);
  assert.match(PAGE, /\$\('fState'\)\.addEventListener\('change', render\)/);
  assert.match(PAGE, /\$\('fRoute'\)\.addEventListener\('change', render\)/);
  assert.doesNotMatch(PAGE, /addEventListener\('input',\s*load\)/);
});

test('並び順: 保留 → 販売可/販売中 → 即時販売 → 販売対象外、同群は最終更新の新しい順', () => {
  assert.match(PAGE, /order: 4[\s\S]{0,400}order: 1[\s\S]{0,400}order: 3[\s\S]{0,400}order: 2[\s\S]{0,400}order: 2/);
  assert.match(PAGE, /classify\(a\)\.order - classify\(b\)\.order/);
  assert.match(PAGE, /return ub\.localeCompare\(ua\);/);
});

// ── サマリーバー ─────────────────────────────────────────────────
test('サマリーは 1 行バー・優先度順・クリックでフィルター', () => {
  const i = (s) => PAGE.indexOf(s);
  assert.ok(i("['即時販売', c.immediate") < i("['販売可', c.eligible"));
  assert.ok(i("['販売可', c.eligible") < i("['保留', c.review"));
  assert.ok(i("['保留', c.review") < i("['候補', c.total"));
  assert.match(PAGE, /\$\('fState'\)\.value = filter/);
  // ROUTE は補助表示（別行）
  assert.match(PAGE, /summarySub/);
  assert.match(PAGE, /ROUTE A（三連複）/);
});

// ── 詳細・操作パネル ─────────────────────────────────────────────
test('詳細パネルに 基本情報 / 表示確認 / 通常操作 / 強い操作 / 内部メモ がある', () => {
  for (const t of ['基本情報', '表示確認', '通常操作', '強い操作（本番の販売状態が変わります）', '内部メモ']) {
    assert.ok(PAGE.includes(`textContent = '${t}'`), `セクションが無い: ${t}`);
  }
  for (const k of ['プラン', '三連複', 'Route', 'PHASE', 'Premium経過', '販売許可日', '最終更新']) {
    assert.ok(PAGE.includes(`kvRow(dl, '${k}'`), `基本情報の項目が無い: ${k}`);
  }
  assert.ok(STYLE.includes('.dt-sec.danger'), '危険操作の視覚区別が無い');
});

test('現在の状態と同じ操作は disabled（適用中を明示）', () => {
  assert.match(PAGE, /mkBtn\('staged',[^)]*isStagedNow\)/);
  assert.match(PAGE, /mkBtn\('review',[^)]*r\.eligibility === 'review'\)/);
  assert.match(PAGE, /mkBtn\('immediate',[^)]*isImmediate/);
  assert.match(PAGE, /mkBtn\('blocked',[^)]*r\.eligibility === 'blocked'\)/);
  assert.match(PAGE, /現在この状態です（適用中）/);
  assert.ok(PAGE.includes("textContent = '適用中'"));
});

test('管理接続は既定で閉じ、接続済みピルを出す', () => {
  assert.match(PAGE, /id="connBody"[^>]*hidden/);
  assert.ok(PAGE.includes('● 管理API 接続済み'));
  assert.match(PAGE, /id="connToggle"/);
  assert.match(PAGE, /id="reload"[^>]*class="btn-primary"/);
});

test('表示プレビューを維持し、上部に要点を横並びで出す', () => {
  assert.ok(PAGE.includes('表示プレビュー'));
  assert.ok(PAGE.includes('管理者プレビュー / 実顧客には影響しません'));
  for (const k of ['PHASE', '受付状態', '商品ページ', '価格・CTA', '購入可否']) {
    assert.ok(PAGE.includes(`cell('${k}'`), `プレビュー要点が無い: ${k}`);
  }
  assert.ok(STYLE.includes('.pv-top'), 'プレビュー上部の横並びカードが無い');
});

test('Email は省略表示 + title で全文を確認できる', () => {
  assert.match(STYLE, /text-overflow:\s*ellipsis/);
  assert.match(PAGE, /em\.title = r\.email/);
});

// ── モバイル ─────────────────────────────────────────────────────
test('モバイルはテーブルをカード化し、横スクロールさせない', () => {
  assert.match(STYLE, /@media \(max-width: 860px\)/);
  assert.match(STYLE, /\.ppe \.tbl thead \{ display: none; \}/);
  assert.match(STYLE, /\.ppe \.tbl tbody tr \{[^}]*border-radius/);
  // 販売許可日・最終更新はモバイルで隠す（Email / 状態 / プラン・Route・PHASE / 操作 のみ）
  assert.match(STYLE, /\.ppe \.tbl tbody td\.c-eligible \{ display: none; \}/);
  assert.match(STYLE, /\.ppe \.tbl tbody td\.c-updated \{ display: none; \}/);
  // 横スクロール用のラッパを持たない
  assert.doesNotMatch(STYLE, /overflow-x:\s*(auto|scroll)/);
});

// ── スタイルが JS 生成 DOM にも適用されること（本番不具合の再発防止）──
test('style は is:global（scoped だと JS 生成要素へ適用されない）', () => {
  assert.match(PAGE, /<style is:global>/);
  assert.doesNotMatch(PAGE, /<style>\s/);
});

test('全 CSS セレクタが .ppe 名前空間に閉じている（グローバル汚染の防止）', () => {
  const bad = [];
  for (const raw of STYLE.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('/*') || line.startsWith('}') || line.startsWith('@') || line.startsWith('<')) continue;
    const m = line.match(/^([^{]+)\{/);
    if (!m) continue;
    for (const sel of m[1].split(',')) {
      const s2 = sel.trim();
      if (!s2) continue;
      if (s2 === '.ppe' || s2.startsWith('.ppe ') || s2.startsWith('.ppe.') || s2.startsWith('.ppe[')) continue;
      bad.push(s2);
    }
  }
  assert.deepEqual(bad, [], '.ppe 名前空間の外にセレクタがある: ' + bad.join(' / '));
});

test('@media にセレクタ前置の誤りが無い', () => {
  assert.doesNotMatch(PAGE, /\.ppe\s+@media/);
  assert.match(STYLE, /@media \(max-width: 860px\)/);
});

test('ビルド後の生成 CSS に scoped 変換が残っていない（dist がある場合のみ）', (t) => {
  const dist = fileURLToPath(new URL('../../../dist/assets/', import.meta.url));
  if (!existsSync(dist)) return t.skip('dist 未生成（build 後に検証される）');
  const file = readdirSync(dist).find((f) => f.startsWith('premium-plus-eligibility') && f.endsWith('.css'));
  if (!file) return t.skip('管理画面 CSS が dist に無い');
  const css = readFileSync(dist + file, 'utf8');
  assert.doesNotMatch(css, /data-astro-cid/, 'scoped 変換されている（JS 生成 DOM にスタイルが当たらない）');
  // JS で生成する要素のスタイルが実在する
  for (const sel of ['.ppe .badge.immediate', '.ppe .btn-detail', '.ppe .tbl tbody td', '.ppe .dt-sec']) {
    assert.ok(css.includes(sel), `生成 CSS に無い: ${sel}`);
  }
  // 名前空間の外へ漏れていない
  assert.doesNotMatch(css, /(^|\})\.(badge|btn-detail|dt-sec|sumbar)[{.\[]/, 'グローバルへ漏れている');
});

// ── read-only / 非破壊 ───────────────────────────────────────────
test('画面から Customers を直接触らない（API 以外の書込経路が無い）', () => {
  assert.doesNotMatch(PAGE, /api\.airtable\.com/);
  assert.doesNotMatch(PAGE, /method:\s*'(PATCH|PUT|DELETE)'/);
  const fetches = PAGE.match(/fetch\(([^)]*)/g) || [];
  for (const f of fetches) assert.match(f, /API|premium-plus-eligibility/, `想定外の fetch: ${f}`);
});

test('顧客データを URL に載せない（recordId をクエリに出さない）', () => {
  assert.doesNotMatch(PAGE, /location\.(search|href)\s*=/);
  assert.doesNotMatch(PAGE, /history\.(push|replace)State/);
  assert.doesNotMatch(PAGE, /\?record=/);
});

// ── AK ダークテーマ（ブラウザ標準の白 UI を残さない）────────────
test('button / select / input に既定のダーク背景と文字色がある', () => {
  assert.match(STYLE, /\.ppe button,[\s\S]{0,80}\.ppe select,[\s\S]{0,80}\.ppe input,[\s\S]{0,80}\.ppe textarea \{[\s\S]{0,400}background-color: var\(--nv-2\)/);
  assert.match(STYLE, /\.ppe select,[\s\S]{0,160}input\[type=search\][\s\S]{0,160}background-color: var\(--nv-0\)/);
  assert.match(STYLE, /--nv-0:\s*#0b1120/);
  assert.match(STYLE, /--gold:\s*#f5c451/);
});

test('主要ボタンに background と color の明示指定がある', () => {
  for (const cls of ['.btn-primary', '.btn-detail', '.btn-ghost', '.b-preview', '.b-staged', '.b-review', '.b-immediate', '.b-blocked']) {
    const m = STYLE.match(new RegExp('\\.ppe \\' + cls + ' \\{([^}]*)\\}'));
    assert.ok(m, `${cls} の定義が無い`);
    assert.match(m[1], /background(-color|-image|:)/, `${cls} に background 指定が無い`);
    assert.match(m[1], /color:/, `${cls} に color 指定が無い`);
  }
});

test('disabled でも白背景に戻らない', () => {
  assert.match(STYLE, /\.ppe button\[disabled\] \{[^}]*background-color: var\(--nv-2\)/);
  assert.match(STYLE, /\.ppe button\[disabled\] \{[^}]*cursor: not-allowed/);
  assert.match(STYLE, /\.ppe button\[disabled\] \{[^}]*opacity/);
});

test('select は標準の白い外観を使わない（appearance 無効化 + 自前シェブロン）', () => {
  assert.match(STYLE, /\.ppe select \{[\s\S]{0,400}appearance: none/);
  assert.match(STYLE, /background-image: url\("data:image\/svg\+xml/);
  assert.match(STYLE, /\.ppe select option \{[^}]*background-color/);
});

test('checkbox は accent-color で AK 配色に寄せる', () => {
  assert.match(STYLE, /\.ppe input\[type=checkbox\] \{[^}]*accent-color: var\(--gold\)/);
});

test('白背景・黒文字の指定が混入していない', () => {
  const white = STYLE.match(/(background(-color)?\s*:\s*(#fff\b|#ffffff|white|rgb\(255,\s*255,\s*255\)))/gi) || [];
  assert.deepEqual(white, [], '白背景の指定がある: ' + white.join(' / '));
  const black = STYLE.match(/color\s*:\s*(#000\b|#000000|black)\s*[;}]/gi) || [];
  assert.deepEqual(black, [], '黒文字の指定がある: ' + black.join(' / '));
});

test('状態バッジはダーク背景ベース（白 pill を使わない）', () => {
  for (const k of ['review', 'staged', 'sale', 'blocked']) {
    const m = STYLE.match(new RegExp('\\.ppe \\.badge\\.' + k + ' \\{([^}]*)\\}'));
    assert.ok(m, `badge.${k} が無い`);
    assert.match(m[1], /background-color: #[0-9a-f]{6}/i, `badge.${k} がダーク背景でない`);
  }
  assert.match(STYLE, /\.ppe \.badge\.immediate \{[^}]*linear-gradient\(135deg, var\(--gold\)/);
});
