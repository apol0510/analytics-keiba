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
test('write payload が変わっていない（action/update の 6 キー）', () => {
  // 送るキーを固定する。増えた分が Airtable の**書き込み**を増やしていないか常に確認すること。
  //   actor            … 既に書いていた UpdatedBy の中身（'admin' 固定をやめただけ・新規列ではない）
  //   expectedUpdatedAt… 競合検知のための **読み取り専用**の版。書き込みではない
  const i = PAGE.indexOf("action: 'update', recordId: r.recordId, plusAction");
  assert.ok(i > -1, 'update の呼び出し形が変わっている');
  const payload = PAGE.slice(i, PAGE.indexOf('});', i))
    .replace(/\/\/[^\n]*/g, ''); // コメント行はキーとして数えない
  // 想定外のキーが増えていないこと（キー名と個数で固定する）
  const tokens = payload.split(',').map((t) => t.trim()).filter(Boolean);
  const names = tokens.map((t) => t.split(':')[0].trim());
  assert.deepEqual(names,
    ['action', 'recordId', 'plusAction', 'reason', 'actor', 'expectedUpdatedAt'],
    `update payload のキーが変わっている: ${JSON.stringify(names)}`);
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
  // 「今すぐ販売可」の disabled には **必ず** !data.overrideEnabled が入る。
  // ⚠️ 2026-09-09: 状態と食い違う操作を押させない条件（conflicts.immediate）を
  //    足したため、`!data.overrideEnabled)` の完全一致では検知できなくなった。
  //    ここは**条件が増えても gate が外れていないこと**を見る（増設を禁止しない）。
  const m = PAGE.match(/mkBtn\('immediate',[\s\S]{0,240}?\)\s*;/);
  assert.ok(m, '「今すぐ販売可」の描画が見つからない');
  assert.match(m[0], /!data\.overrideEnabled/, 'gate（overrideEnabled）が disabled から外れている');
});

// ── 一覧はテーブル。write ボタンを露出させない ───────────────────
test('一覧は日常運用に必要な列だけ（内部の軸を一覧に出さない）', () => {
  // ⚠️ 2026-09-09 確定仕様。Route / 区分 / 販売CTA / 表示判定 / 実閲覧 / 案内 / PHASE は
  //    内部の軸・集計なので一覧から外し、詳細パネルと「効果測定」で見る
  //    （横スクロールを日常運用で要求しないため）。
  for (const th of ['顧客', '状態', 'プラン', '販売許可日', '最終更新', '操作']) {
    assert.ok(PAGE.includes('>' + th + '</th>'), `列が無い: ${th}`);
  }
  for (const th of ['Route', 'PHASE', '区分', '販売CTA', '表示判定', '実閲覧']) {
    assert.ok(!PAGE.includes('<th class="c-' + ({
      Route: 'route', PHASE: 'phase', 区分: 'kind', 販売CTA: 'upsell', 表示判定: 'display', 実閲覧: 'realview',
    })[th] + '">'), `内部の軸が一覧に残っている: ${th}`);
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
test('主状態は 4 分類。判定を画面で作らない（2026-09-09 確定仕様）', () => {
  // 購入可能 / 販売停止中 / 段階表示中 / 対象外 の 4 つだけ
  for (const k of ['sale', 'paused', 'staged', 'out']) {
    assert.ok(STYLE.includes(`.badge.${k}`), `バッジ CSS が無い: ${k}`);
  }
  assert.match(PAGE, /function classify\(r\)/);
  assert.match(PAGE, /L\.classifyListState\(r\)/, '分類を単一源に委譲していない');
  // 内部の軸をラベルに使わない
  for (const w of ["short: '即時販売'", "short: 'PHASE ' + r.phase", "'段階公開中 PHASE '"]) {
    assert.ok(!PAGE.includes(w), `一覧に内部用語が残っている: ${w}`);
  }
  // 一覧の分類で override / phase を直接見ない（漏れの原因だった）
  assert.ok(!/function classify\(r\)[\s\S]{0,400}r\.overrideApplied/.test(PAGE),
    'classify が override を見ている（購入可能を取り逃す）');
});

test('「購入可能」はサーバーが解決した購入可否だけで決める', () => {
  const mod = readFileSync(new URL('./premiumPlusAdminListView.js', import.meta.url).pathname, 'utf8');
  assert.match(mod, /r\.purchaseEnabled === true\) return LIST_STATE\.SALE/,
    '購入可能の判定が purchaseEnabled だけになっていない');
  assert.ok(!/overrideApplied/.test(mod), '一覧の分類が override を見ている（片方が漏れる）');
  assert.match(mod, /r\.salePaused === true\) return LIST_STATE\.PAUSED/, '停止が最優先になっていない');
});

// ── 検索・フィルター ─────────────────────────────────────────────
test('状態フィルター 5 種 + Route フィルター + Email 検索（クライアント側のみ）', () => {
  // 状態フィルタは単一源が入れる（内部用語「即時販売」を選択肢に出さない）
  assert.match(PAGE, /function fillStateFilter\(\)/);
  assert.match(PAGE, /window\.__ppList\.listStateFilterOptions\(\)/);
  assert.ok(!PAGE.includes('<option value="immediate">'), '「即時販売」が状態フィルタに残っている');
  assert.ok(PAGE.includes('<option value="sanrenpuku">'));
  assert.ok(PAGE.includes('<option value="premium_30d">'));
  // ⚠️ 2026-09-10: 検索は日常運用の主入口なので常時展開し、
  //    完全一致で自動的に詳細が開くことを placeholder でも伝える。
  assert.match(PAGE, /id="q"[^>]*placeholder="[^"]*完全一致[^"]*"/);
  assert.match(PAGE, /<div class="email-search open" id="qBox">/, '検索が折りたたまれている');
  // 手元に完全なアドレスが無くても引けること（氏名でもアドレスの一部でも絞り込める）
  assert.match(PAGE, /\$\{String\(r\.email \|\| ''\)\} \$\{String\(r\.name \|\| ''\)\}/);
  assert.match(PAGE, /hay\.includes\(q\)/);
  // 入力中は再描画のみ。API は呼ばない（サーバー検索は Enter / 検索ボタン / change だけ）
  assert.match(PAGE, /\$\('q'\)\.addEventListener\('input', \(\) => \{ syncSearchBadge\(\); render\(\); \}\)/);
  assert.match(PAGE, /\$\('fState'\)\.addEventListener\('change', render\)/);
  assert.match(PAGE, /\$\('fRoute'\)\.addEventListener\('change', render\)/);
  assert.doesNotMatch(PAGE, /addEventListener\('input',\s*load\)/);
  assert.doesNotMatch(PAGE, /addEventListener\('input',[^)]*lookupOutsideCandidates/);
});

test('並び順: 購入可能 → 販売停止中 → 段階表示中 → 対象外、同群は最終更新の新しい順', () => {
  assert.match(PAGE, /\{ sale: 1, paused: 2, staged: 3, out: 4 \}/);
  assert.match(PAGE, /classify\(a\)\.order - classify\(b\)\.order/);
  assert.match(PAGE, /return ub\.localeCompare\(ua\);/);
});

// ── サマリーバー ─────────────────────────────────────────────────
test('サマリーは主状態 4 分類の運営サマリー・クリックでフィルター', () => {
  // 「購入可能 5名 / 販売停止中 0名 / 段階表示中 13名 / 対象外 N名」を単一源から作る
  assert.match(PAGE, /L\.summarizeListStates\(rowsForSum\)\.items/);
  assert.match(PAGE, /card\.className = 'sumcard tone-' \+ it\.tone/);
  assert.ok(!PAGE.includes("['即時販売', c.immediate"), '内部の軸がサマリーに残っている');
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

// ── オーバーレイの到達性（2026-07-30 本番で「戻れない / 上部が隠れる / スクロール不可」が発生）──
//   サイト共通ヘッダは BaseLayout で position: fixed / z-index: 1000。
//   パネルとモーダルがそれより下だと、上部のタイトルと閉じる × がヘッダに隠れて操作不能になる。
test('パネル / モーダルは共通ヘッダ（z-index:1000）より上に出す', () => {
  const z = (sel) => {
    const m = STYLE.match(new RegExp('\\.ppe \\' + sel + ' \\{([^}]*)\\}'));
    assert.ok(m, `${sel} の定義が無い`);
    const zi = m[1].match(/z-index:\s*(\d+)/);
    assert.ok(zi, `${sel} に z-index が無い`);
    return Number(zi[1]);
  };
  const dt = z('.dt-backdrop');
  const pv = z('.pv-backdrop');
  assert.ok(dt > 1000, `詳細パネルが共通ヘッダより下: z-index=${dt}`);
  assert.ok(pv > 1000, `プレビューが共通ヘッダより下: z-index=${pv}`);
  assert.ok(pv >= dt, 'プレビューが詳細パネルより下にある');
});

test('詳細パネルの見出し行は sticky で、戻る / 閉じるが常に届く', () => {
  const m = STYLE.match(/\.ppe \.dt-head \{([^}]*)\}/);
  assert.ok(m, '.dt-head の定義が無い');
  assert.match(m[1], /position: sticky/);
  assert.match(m[1], /top: 0/);
  assert.match(m[1], /background: #[0-9a-f]{6}/i, 'sticky 見出しの背景が無い（本文が透けて重なる）');
  assert.match(STYLE, /\.ppe \.dt-panel \{[^}]*overflow-y: auto/);
});

test('プレビューは本文だけを内部スクロールし、操作部は固定される', () => {
  assert.match(STYLE, /\.ppe \.pv-modal \{[^}]*max-height: \d+vh/);
  assert.match(STYLE, /\.ppe \.pv-modal \{[^}]*flex-direction: column/);
  assert.match(STYLE, /\.ppe \.pv-scroll \{[^}]*overflow-y: auto/);
  assert.match(STYLE, /\.ppe \.pv-scroll \{[^}]*min-height: 0/, 'flex 子要素の min-height:0 が無いとスクロールしない');
  assert.match(PAGE, /<div class="pv-scroll" id="pvScroll">/);
});

test('戻るボタンが詳細・プレビューの両方にある（閉じる × だけに依存しない）', () => {
  assert.match(PAGE, /id="dtBack" class="btn-back">← 一覧へ戻る/);
  assert.match(PAGE, /id="pvBack" class="btn-back">← 詳細へ戻る/);
  assert.match(PAGE, /\$\('dtBack'\)\.addEventListener\('click', closeDetail\)/);
  assert.match(PAGE, /\$\('pvBack'\)\.addEventListener\('click', closePreview\)/);
  // Esc と背景クリックも維持
  assert.match(PAGE, /if \(e\.key !== 'Escape'\) return/);
  assert.match(PAGE, /if \(e\.target === \$\('dtBackdrop'\)\) closeDetail\(\)/);
});

test('背面スクロール固定は閉じたときに必ず解除される', () => {
  assert.match(PAGE, /function lockScroll\(\) \{ document\.body\.style\.overflow = 'hidden'; \}/);
  assert.match(PAGE, /function unlockScroll\(\) \{ document\.body\.style\.overflow = ''; \}/);
  // 片方を閉じてももう片方が開いていれば固定を維持する（解除漏れ・二重解除の両方を防ぐ）
  assert.match(PAGE, /closeDetail\(\)[\s\S]{0,200}if \(\$\('pvBackdrop'\)\.hidden\) unlockScroll\(\)/);
  assert.match(PAGE, /closePreview\(\)[\s\S]{0,200}if \(\$\('dtBackdrop'\)\.hidden\) unlockScroll\(\)/);
});

test('段階公開の切替が主操作として強調され、404 のときは操作方法を案内する', () => {
  assert.match(PAGE, /class="ctl-main" for="pvPhase">段階公開の表示確認/);
  assert.match(STYLE, /\.ppe \.pv-controls \.ctl-main \{[^}]*color: var\(--gold\)/);
  assert.match(PAGE, /function renderPreviewHint\(p\)/);
  assert.match(PAGE, /renderPreviewHint\(p\);/);
  // eligible で実データが PHASE 1〜3 のとき → PHASE 切替を案内
  assert.match(PAGE, /段階公開の表示確認」で PHASE 2〜4 を選んでください/);
  // review / blocked のとき → PHASE を変えても表示されない理由を説明
  assert.match(PAGE, /PHASE を切り替えても商品ページは表示されません/);
  assert.match(PAGE, /実データは変わりません/);
});

test('プレビューの payload は変更しない（read-only 契約の維持）', () => {
  assert.match(PAGE, /atMin:\s*\$\('pvTime'\)\.value === '' \? null : Number/);
  assert.match(PAGE, /phaseDaysAgo:\s*\$\('pvPhase'\)\.value === '' \? null : Number/);
  assert.doesNotMatch(PAGE, /renderPreviewHint[\s\S]{0,600}action:\s*'update'/);
});
