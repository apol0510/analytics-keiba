/**
 * homeCta.guard.test.mjs — トップの無料導線と索引ページを固定する（2026-08-21）
 *
 * 【なぜ必要か】
 *   1. ヒーロー（H1 セクション）に**押せる要素が 1 つも無く**、本文で最初の無料CTAが
 *      3.8 画面ぶん下（y=3240）にあった。しかもそれより上に見えるのは有料実績のみで、
 *      「無料で試す前に有料を見せる」順番になっていた。
 *   2. `/free/` は **404** で、nav「無料予想」もフッターも南関固定。
 *      中央競馬目当ての人が南関に着地していた。
 *
 * どちらも UI 改修や revert で静かに戻りやすいのでテストで固定する。
 */
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const R = (p) => resolve(HERE, '../../', p);
const index = readFileSync(R('pages/index.astro'), 'utf8');
const layout = readFileSync(R('layouts/BaseLayout.astro'), 'utf8');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

console.log('homeCta.guard');

t('索引ページ /free/ が存在する（404 に戻さない）', () => {
  assert.ok(existsSync(R('pages/free/index.astro')),
    'pages/free/index.astro が無い。nav が南関固定に戻り JRA 目当てを取りこぼす');
});

t('索引ページは中央・南関の両方へリンクする', () => {
  const idx = readFileSync(R('pages/free/index.astro'), 'utf8');
  // href は CATEGORIES 配列の値として持つ（href={c.href}）ので、パス文字列の存在で見る。
  assert.ok(idx.includes('/free/jra/'), '中央競馬へのパスが無い');
  assert.ok(idx.includes('/free/nankan/'), '南関競馬へのパスが無い');
  assert.match(idx, /href=\{c\.href\}/, 'カード自体がリンクになっていない');
});

t('索引ページは買い目・評価数値を出さない', () => {
  const idx = readFileSync(R('pages/free/index.astro'), 'utf8');
  // 「買い目は有料版で公開」という**案内文**は許可。実データの描画が無いことを見る。
  for (const banned of ['bettingLines', 'computerIndex', 'sourceComputerIndex', 'aiIndex', 'horse.pt', 'importance']) {
    assert.equal(idx.includes(banned), false, `索引ページに ${banned} が現れている`);
  }
});

t('ヒーローに無料予想への CTA がある（押せる要素ゼロに戻さない）', () => {
  const heroStart = index.indexOf('<h1 class="hero-title"');
  const heroEnd = index.indexOf('hero-stats-section');
  assert.ok(heroStart > -1 && heroEnd > heroStart, 'ヒーローの範囲を特定できない');
  const hero = index.slice(heroStart, heroEnd);
  assert.match(hero, /<a[^>]+href="\/free\/"/,
    'ヒーロー内（H1〜統計カードの間）に /free/ への <a> が無い');
});

t('ヒーロー CTA は統計カードより前にある（順序の逆転を防ぐ）', () => {
  const cta = index.indexOf('hero-cta-btn');
  const stats = index.indexOf('hero-stats-section');
  assert.ok(cta > -1 && cta < stats, 'CTA が統計カードより後ろにある');
});

t('nav の親「無料予想」とフッターが索引を指す（南関固定に戻さない）', () => {
  const parent = /<a href="\/free\/">[^<]*<span class="nav-icon">🔍<\/span>/;
  assert.match(layout, parent, 'PC nav の親項目が索引を指していない');
  assert.match(layout, /<li><a href="\/free\/">無料予想<\/a><\/li>/, 'フッターが索引を指していない');
  assert.match(layout, /href="\/free\/"[^>]*mobile-nav-menu/, 'モバイル nav の親項目が索引を指していない');
});

t('子項目（中央 / 南関）は直リンクのまま残る', () => {
  assert.match(layout, /href="\/free\/jra\/"/);
  assert.match(layout, /href="\/free\/nankan\/"/);
});

console.log(`homeCta.guard: ${passed} 件すべて通過\n`);

/* ── 名称の一致（2026-08-21 追加） ────────────────────────────────
   nav の文字と着地ページの H1 がズレていると「押した先に来た」が確定しない。
   nav = 無料予想 / H1 = 今日のレースの見どころ で 1 日ズレていた。 */
const board = readFileSync(R('components/RaceViewpointsBoard.astro'), 'utf8');
let passed2 = 0;
const t2 = (name, fn) => { fn(); passed2 += 1; console.log(`  ✓ ${name}`); };

console.log('homeCta.guard（名称の一致）');

t2('H1 が nav と同じ「無料予想」である', () => {
  assert.match(board, /<h1 class="rvb-title">無料予想/,
    'nav は「無料予想」なので H1 も一致させる');
});

t2('説明「今日のレースの見どころ」を落としていない', () => {
  assert.match(board, /rvb-subtitle">今日のレースの見どころ</,
    '「無料予想」単独だと買い目を期待させる。内容の説明を必ず併記する');
});

t2('買い目は有料版である旨の案内が残っている', () => {
  assert.ok(board.includes('PAID_CTA'), '有料版への案内が消えている');
});

t2('各ページの title も「無料予想」で始まる', () => {
  for (const f of ['pages/free/jra.astro', 'pages/free/nankan.astro']) {
    const src = readFileSync(R(f), 'utf8');
    assert.match(src, /title=\{`無料予想（/, `${f} の title が「無料予想」で始まっていない`);
  }
});

console.log(`homeCta.guard（名称の一致）: ${passed2} 件すべて通過\n`);

/* ── URL 変更と 301（2026-08-21 追加） ────────────────────────────
   /race-viewpoints/ → /free/ へ移した。既に共有されたリンクを死なせないため
   301 を恒久的に残す。ワイルドカードのフォールバックは**禁止**
   （過去に `/* /index.html 200` が全 SSR ページをトップに化けさせた事故がある）。 */
const toml = readFileSync(resolve(HERE, '../../../netlify.toml'), 'utf8');
let passed3 = 0;
const t3 = (name, fn) => { fn(); passed3 += 1; console.log(`  ✓ ${name}`); };

console.log('homeCta.guard（URL と 301）');

t3('旧 URL から新 URL への 301 が 3 経路とも残っている', () => {
  for (const [from, to] of [
    ['/race-viewpoints/', '/free/'],
    ['/race-viewpoints/jra/', '/free/jra/'],
    ['/race-viewpoints/nankan/', '/free/nankan/'],
  ]) {
    const re = new RegExp(`from = "${from.replace(/\//g, '\\/')}"[\\s\\S]{0,80}?to = "${to.replace(/\//g, '\\/')}"[\\s\\S]{0,40}?status = 301`);
    assert.match(toml, re, `${from} → ${to} の 301 が無い`);
  }
});

t3('末尾スラッシュ無しの旧 URL も 301 でひろう', () => {
  for (const from of ['/race-viewpoints', '/race-viewpoints/jra', '/race-viewpoints/nankan']) {
    assert.ok(toml.includes(`from = "${from}"`), `${from}（末尾スラッシュ無し）の 301 が無い`);
  }
});

t3('_redirects にワイルドカードのフォールバックを入れない', () => {
  const rd = readFileSync(resolve(HERE, '../../../public/_redirects'), 'utf8');
  const live = rd.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  for (const line of live) {
    assert.equal(/^\/\*\s/.test(line.trim()), false,
      `SPA フォールバックは禁止（全 SSR ページがトップに化ける）: ${line}`);
  }
});

t3('新 URL 側にページ実体がある', () => {
  for (const f of ['pages/free/index.astro', 'pages/free/jra.astro', 'pages/free/nankan.astro']) {
    assert.ok(existsSync(R(f)), `${f} が無い`);
  }
});

t3('コード内に旧 URL の参照が残っていない', () => {
  for (const f of ['layouts/BaseLayout.astro', 'pages/index.astro', 'pages/free-signup.astro']) {
    const src = readFileSync(R(f), 'utf8');
    assert.equal(src.includes('/race-viewpoints/'), false, `${f} に旧 URL が残っている`);
  }
});

console.log(`homeCta.guard（URL と 301）: ${passed3} 件すべて通過\n`);

/* ── ナビの並び（2026-08-21 追加） ────────────────────────────────
   以前は「AI予想プレビュー」と「無料予想」が隣り合い、どちらも 中央/南関 の
   同じ形の submenu で見分けが付かず、有料への導線が先頭に来ていた。
   無料を先頭に、プレビューは「有料版」へ統合した。 */
let passed4 = 0;
const t4 = (name, fn) => { fn(); passed4 += 1; console.log(`  ✓ ${name}`); };

console.log('homeCta.guard（ナビの並び）');

/**
 * nav-menu 内のトップ項目の並び（nav-text の中身）を取り出す。
 *
 * ⚠️ `nav-login` / `nav-dashboard` は**ログイン状態で入れ替わる同じ 1 枠**（どちらも「マイページ」）。
 *    両方数えると実際より 1 個多くなるので、初期表示で隠れているものは除く。
 *    ログアウトはスクリプトが後から差し込むため静的 HTML には無い。
 */
function topLevelNavTexts(src) {
  const start = src.indexOf('<ul class="nav-menu"');
  // ⚠️ 範囲は `</nav>` で切る。`nav-dashboard` は後半のスクリプトにも出てくるため、
  //    それを目印にすると JS 側のテンプレート文字列（ログアウト等）まで拾ってしまう。
  const end = src.indexOf('</nav>', start);
  const menu = src.slice(start, end);
  const items = menu.split(/<li\b/).slice(1);
  return items
    .filter((li) => !/style="display:\s*none/.test(li.slice(0, li.indexOf('>'))))
    .map((li) => (li.match(/<span class="nav-text">([^<]+)<\/span>/) || [])[1])
    .filter(Boolean);
}

t4('無料予想がプレビューより前にある', () => {
  const texts = topLevelNavTexts(layout);
  const free = texts.indexOf('無料予想');
  const paid = texts.indexOf('有料版');
  assert.ok(free > -1, 'トップ項目に「無料予想」が無い');
  assert.ok(paid > -1, 'トップ項目に「有料版」が無い');
  assert.ok(free < paid, `無料予想(${free}) が 有料版(${paid}) より後ろにある`);
});

t4('プレビューはトップ項目ではなく「有料版」の中にある', () => {
  const texts = topLevelNavTexts(layout);
  assert.equal(texts.includes('AI予想プレビュー'), false,
    'プレビューがトップ項目に戻っている（有料導線が無料より前に出る）');
  // 有料版 submenu の中にプレビューへのリンクがあること
  assert.match(layout, /submenu-group-label">🎁 予想プレビュー[\s\S]{0,400}?\/free-prediction\/jra\//);
  assert.match(layout, /submenu-group-label">🎁 予想プレビュー[\s\S]{0,400}?\/free-prediction\/nankan\//);
});

t4('料金プランへの導線が消えていない', () => {
  assert.match(layout, /submenu-group-label">💰 料金プラン/);
  assert.ok(layout.includes('href="/pricing/"'), 'pricing へのリンクが無い');
});

t4('トップ項目が 7 個以内（はみ出し防止）', () => {
  const texts = topLevelNavTexts(layout);
  assert.ok(texts.length <= 7,
    `トップ項目が ${texts.length} 個。1009px でナビが画面外にはみ出す: ${texts.join(' / ')}`);
});

t4('モバイル nav も同じ並びになっている', () => {
  // ⚠️ 'mobile-nav-menu' はハンバーガーの onclick にも出てくる。
  //    id 属性を目印にして本体の <nav> から切り出す。
  const start = layout.indexOf('<nav class="mobile-nav-menu"');
  assert.ok(start > -1, 'モバイル nav 本体が見つからない');
  const mb = layout.slice(start, layout.indexOf('</nav>', start));
  assert.ok(mb.indexOf('🔍</span> 無料予想') < mb.indexOf('💎</span> 有料版'),
    'モバイルでも無料予想を先に出す');
  assert.equal(mb.includes('AI予想プレビュー'), false,
    'モバイル nav にプレビューがトップ項目として残っている');
});

console.log(`homeCta.guard（ナビの並び）: ${passed4} 件すべて通過\n`);

/* ── フッターの名称も nav と揃える（2026-08-21 追加） ──────────────
   nav を「無料予想 / 有料版」に整理したのに、フッターだけ旧名称
   「AI予想プレビュー」が残り、同じものが 2 つの名前で呼ばれていた。 */
let passed5 = 0;
const t5 = (name, fn) => { fn(); passed5 += 1; console.log(`  ✓ ${name}`); };

console.log('homeCta.guard（フッターの名称）');

t5('サイト全体から旧名称「AI予想プレビュー」が消えている', () => {
  // ⚠️ HTML コメント `<!-- -->` は配信 HTML にそのまま出るので、
  //    説明用の注記は Astro の JSX コメント `{/* */}` で書くこと。
  //    ここでは JSX コメントだけを取り除いて、実際に配信される文字列を見る。
  const visible = layout.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  assert.equal(visible.includes('AI予想プレビュー'), false,
    'nav は「有料版」なのに旧名称が残っている（同じものが 2 つの名前で呼ばれる）');
});

t5('フッターでも無料予想が有料版プレビューより先にある', () => {
  const i = layout.lastIndexOf('footer-links');
  const foot = layout.slice(layout.indexOf('footer-links'));
  assert.ok(i > -1, 'フッターが見つからない');
  const free = foot.indexOf('>無料予想<');
  const paid = foot.indexOf('>有料版プレビュー<');
  assert.ok(free > -1, 'フッターに「無料予想」が無い');
  assert.ok(paid > -1, 'フッターに「有料版プレビュー」が無い');
  assert.ok(free < paid, 'フッターでも無料を先に出す');
});

console.log(`homeCta.guard（フッターの名称）: ${passed5} 件すべて通過\n`);
