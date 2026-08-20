/**
 * memberGateStrength.guard.test.mjs
 *
 * 2026-08-20 の本番不具合の再発防止。
 *
 * 【何が起きたか】
 *   `[data-member-only] { display: none; }` は詳細度 (0,2,0)。
 *   あとから書いた `.rvb-member-row { display: flex; }` も (0,2,0) で同点になり、
 *   **後勝ちで常に表示**されていた。結果、未登録の人にも会員限定の拡張が見えており、
 *   無料登録しても「登録CTAが消えるだけ」で違いが分からなかった。
 *
 * 【ここで固定する仕様】
 *   1. 非表示ルールは `:not(.is-unlocked)` を伴い、`!important` を付ける（誰にも負けない）
 *   2. `:not` を伴わない裸の `[data-member-only] { display: none }` を書かない（同点負けの元）
 *   3. ゲート以外のどのルールも `display` を `!important` で指定しない（ゲートを覆せなくする）
 *   4. 冒頭CTA（未登録）と冒頭の登録済み表示が、アコーディオンの外に存在する
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = resolve(HERE, '../../components/RaceViewpointsBoard.astro');
const src = readFileSync(BOARD, 'utf8');
const style = src.slice(src.indexOf('<style'), src.lastIndexOf('</style>'));

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

console.log('memberGateStrength.guard');

t('非表示ルールは :not(.is-unlocked) + !important である', () => {
  assert.match(style, /\[data-member-only\]:not\(\.is-unlocked\)\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(style, /\[data-guest-only\]\.is-hidden\s*\{[^}]*display:\s*none\s*!important/);
});

t('裸の [data-member-only] { display:none } を書かない（同点負けの原因）', () => {
  // `:not(` も `.` も伴わない [data-member-only] だけのセレクタで display を指定していないこと
  const bare = /(^|[\s,}])\[data-member-only\]\s*\{[^}]*display\s*:/m;
  assert.equal(bare.test(style), false,
    '[data-member-only] 単独で display を指定すると、同じ詳細度の .class 規則に後勝ちされる');
});

t('ゲート以外に display の !important が無い（ゲートを覆せない）', () => {
  const rules = [...style.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const offenders = rules
    .filter(([, , body]) => /display\s*:[^;]*!important/.test(body))
    .map(([, sel]) => sel.trim().replace(/\s+/g, ' '))
    .filter((sel) => !/data-member-only|data-guest-only/.test(sel));
  assert.deepEqual(offenders, [],
    `display の !important はゲート専用。他で使うとゲートを覆せる: ${offenders.join(' / ')}`);
});

t('会員限定要素に使う class は、ゲートより強い display 指定を持たない', () => {
  // markup 上で data-member-only が付いている要素の class を集める
  const gated = [...src.matchAll(/class="([^"]*)"[^>]*data-member-only/g)]
    .flatMap(([, cls]) => cls.split(/\s+/))
    .filter(Boolean);
  assert.ok(gated.length > 0, 'data-member-only 付き要素が見つからない');
  for (const cls of new Set(gated)) {
    // その class 単独（属性セレクタなし）で display を指定している規則を探す
    const re = new RegExp(`(^|[\\s,}])\\.${cls}\\s*\\{([^}]*)\\}`, 'm');
    const m = style.match(re);
    if (!m) continue;
    if (!/display\s*:/.test(m[2])) continue;
    // 指定していてもよいが、ゲートが !important なので必ず負ける。
    // 万一 !important が付いていたら事故なので落とす。
    assert.equal(/display\s*:[^;]*!important/.test(m[2]), false,
      `.${cls} が display を !important で指定しており、ゲートを覆す`);
  }
});

t('冒頭CTA（未登録）がアコーディオンの外にある', () => {
  const header = src.slice(0, src.indexOf('</header>'));
  assert.match(header, /class="rvb-topgate"[^>]*data-guest-only/);
  assert.match(header, /href="\/free-signup\/"/);
});

t('冒頭に登録済みの人向けの表示がある', () => {
  const header = src.slice(0, src.indexOf('</header>'));
  assert.match(header, /class="rvb-topmember"[^>]*data-member-only/);
});

t('会員限定である旨のバッジが付いている', () => {
  assert.match(src, /rvb-member-badge/);
  assert.match(src, /rvb-member-rowbadge/);
});

console.log(`memberGateStrength.guard: ${passed} 件すべて通過\n`);
