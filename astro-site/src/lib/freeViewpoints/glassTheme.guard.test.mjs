/**
 * glassTheme.guard.test.mjs — `/free/` 全体をガラスモーフィズムで統一する（2026-09-27 MK 確定 / decisions 追記 3）。
 *
 * 「一部だけガラス、他は通常フラット」を防ぐ。可読性（印・操作文字）を薄くしない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const board = readFileSync(join(ROOT, 'src/components/RaceViewpointsBoard.astro'), 'utf-8');
const glass = board.slice(board.indexOf('2026-09-27 MK 確定（3 版目）: /free/ 全体をガラスモーフィズムで統一'), board.lastIndexOf('</style>'));

test('共通トークン（単一源）がある', () => {
  assert.ok(glass.length > 0, 'ガラスの層が無い');
  for (const v of ['--g-bg:', '--g-line:', '--g-line-strong:', '--g-hi:', '--g-blur:', '--g-text:']) {
    assert.ok(glass.includes(v), `${v} が無い`);
  }
});

test('上部カード・折りたたみ・登録案内・会員表示は同じガラス（ぼかし・境界・内側の明るさ）', () => {
  const m = glass.match(/\.rvb-headcard, \.rvb-venuecmp, \.rvb-signupbox, \.rvb-topmember, \.rvb-guide\s*\{([^}]*)\}/);
  assert.ok(m, '最上位ブロックの共通ガラスが無い');
  for (const p of ['var(--g-bg)', 'var(--g-line)', 'backdrop-filter: var(--g-blur)', 'var(--g-hi)']) {
    assert.ok(m[1].includes(p), `共通ガラスに ${p} が無い`);
  }
});

test('詳細の中のブロックもガラスに寄せる（フラットのまま残さない）', () => {
  const m = glass.match(/\.rvb-howto, \.rvb-member, \.rvb-cta, \.rvb-highlight, \.rvb-horse, \.rvb-sentence, \.lg, \.rvb-helpbtn, \.rvb-freshness\s*\{([^}]*)\}/);
  assert.ok(m && m[1].includes('backdrop-filter') && m[1].includes('var(--g-hi)'), '入れ子のガラスが無い');
});

test('会場タブはベタ塗りにしない（選択中も半透明のガラス）', () => {
  const m = glass.match(/\.rvb-venuetab\[aria-selected="true"\]\s*\{([^}]*)\}/);
  assert.ok(m, '選択中タブの指定が無い');
  assert.ok(/rgba\(/.test(m[1]) && !/#7c3aed/.test(m[1]), '選択中タブがベタ塗りのまま');
  assert.ok(/:root\[data-rvb-venuetabs="on"\] \.rvb-venuebar\s*\{[^}]*backdrop-filter/.test(glass), 'タブ帯がガラスでない');
});

test('会場見出しの範囲表示もガラスのラベル', () => {
  assert.ok(/\.rvb-venue-count\s*\{[^}]*border:[^}]*var\(--g-hi\)/.test(glass), '範囲ラベルがガラスでない');
});

test('有料版の実績バナーも /free/ の中だけガラスに寄せる（他ページのバナーは変えない）', () => {
  assert.ok(/\.rvb-resultslot :global\(\.scb-banner\)\s*\{[^}]*backdrop-filter/.test(glass), '実績バナーがガラスでない');
  const banner = readFileSync(join(ROOT, 'src/components/ResultsShowcaseBanner.astro'), 'utf-8');
  assert.equal(banner.includes('backdrop-filter'), false, 'バナー本体を変えている（他ページに波及する）');
});

test('印と操作文字は薄くしない（可読性優先）', () => {
  const rule = (sel) => (glass.match(new RegExp(`${sel.replace(/[.[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) || [])[1] || '';
  for (const sel of ['.rm-num', '.rm-name']) assert.ok(/color:\s*#f8fafc/.test(rule(sel)), `${sel} が明るい白でない`);
  assert.ok(/text-shadow/.test(rule('.rm-main .rm-mark')), '◎ に視認性の補助が無い');
  assert.equal(/opacity:\s*0?\.[0-5]/.test(rule('.rvb-more')), false, '「詳細」を薄くしている');
  assert.ok(/border:/.test(rule('.rvb-more')), '「詳細」が操作できる見た目でない');
});

test('左端の強い色帯を復活させない', () => {
  assert.equal(/border-left:\s*[2-9]px/.test(glass), false, 'ガラスの層に左端の色帯がある');
  assert.ok(/\.rvb-sentence\s*\{[^}]*border: 1px solid/.test(glass), '見どころの文が左の色帯のまま');
  assert.ok(/\.rvb-horse\s*\{[^}]*border: 1px solid/.test(glass), '出走馬カードが左の色帯のまま');
});
