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

test('文字パレット（単一源）があり、純白を主要文字色にしない（追記 4）', () => {
  for (const v of ['--t-hero:', '--t-name:', '--t-main:', '--t-sub:', '--t-note:', '--t-action:', '--t-glow:']) {
    assert.ok(glass.includes(v), `${v} が無い`);
  }
  // ガラスの層（3 版目以降）で純白を文字色に使わない
  assert.equal(/(^|[;{\s])color:\s*(#fff\b|#ffffff|#f8fafc|#f1f5f9)/i.test(glass), false, 'ガラスの層に純白の文字色がある');
  const rule = (sel) => (glass.match(new RegExp(`(?:^|[}\\n])\\s*${sel.replace(/[.[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) || [])[1] || '';
  assert.ok(/var\(--t-hero\)/.test(rule('.rvb-title, .rvb-headcard .rvb-title')), '見出しがアイスブルーでない');
  assert.ok(/var\(--t-action\)/.test(glass.match(/\.rvb-more, \.rvb-closebtn, [^{]*\{([^}]*)\}/)[1]), '操作文字がシアンでない');
});

test('印はガラスのチップ（◎＝赤系＋glow、○▲△＝シアン系）。馬番も同じ色温度', () => {
  // 同じセレクタが複数あるときは後勝ち（実際に効く方）を見る
  const rule = (sel) => {
    const all = [...glass.matchAll(new RegExp(`\\n\\s*${sel.replace(/[.[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))];
    return all.length ? all[all.length - 1][1] : '';
  };
  assert.ok(/border:/.test(rule('.rm, .rm-rest')) && /background:/.test(rule('.rm, .rm-rest')), '印がチップになっていない');
  assert.ok(/text-shadow/.test(rule('.rm-main .rm-mark')) && /#fda4af/i.test(rule('.rm-main .rm-mark')), '◎ が赤系＋glow でない');
  assert.ok(/#7dd3fc/i.test(rule('.rm-mark')), '○▲△ がシアン系でない');
  assert.ok(/var\(--t-name\)/.test(rule('.rm-num')), '馬番が同じ色温度でない');
});

test('操作文字・小さい文字を薄くしない（透明度で下げない）', () => {
  assert.equal(/\.rvb-more[^{]*\{[^}]*opacity:\s*0?\.[0-6]/.test(glass), false, '「詳細」を薄くしている');
  for (const sel of ['--t-sub', '--t-note']) {
    const hex = (glass.match(new RegExp(`${sel}:\\s*(#[0-9a-f]{6})`, 'i')) || [])[1];
    assert.ok(hex, `${sel} が無い`);
    // 暗いネイビー背景（#0b1a30 相当）に対してコントラスト 4.5:1 以上
    const lum = (h) => {
      const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (lum(hex) + 0.05) / (lum('#0b1a30') + 0.05);
    assert.ok(ratio >= 4.5, `${sel} のコントラスト不足（${ratio.toFixed(2)}）`);
  }
});

test('左端の強い色帯を復活させない', () => {
  assert.equal(/border-left:\s*[2-9]px/.test(glass), false, 'ガラスの層に左端の色帯がある');
  assert.ok(/\.rvb-sentence\s*\{[^}]*border: 1px solid/.test(glass), '見どころの文が左の色帯のまま');
  assert.ok(/\.rvb-horse\s*\{[^}]*border: 1px solid/.test(glass), '出走馬カードが左の色帯のまま');
});
