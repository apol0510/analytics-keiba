/**
 * adminResultsUiGuard.test.mjs — Premium Plus 結果入力画面（/admin/premium-plus-results/）の UI 契約
 *   node --test src/lib/premiumPlus/adminResultsUiGuard.test.mjs
 *
 * この画面は 馬番チップ（1〜18 × 3）と 的中組合せ option を **JS で生成**する。
 * Astro の scoped style は `.chip[data-astro-cid-xxx]` へ変換され JS 生成 DOM に当たらないため、
 * `is:global` + `.ppr` 名前空間で書くことを固定する（2026-07-30 に本番で白ボタン化して発覚）。
 *
 * 保存ロジック・API 契約・スキーマ・プレビュー生成は対象外（UI のみ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = readFileSync(fileURLToPath(new URL('../../pages/admin/premium-plus-results.astro', import.meta.url)), 'utf8');
const STYLE = PAGE.slice(PAGE.indexOf('<style is:global>'), PAGE.indexOf('</style>'));

/** 宣言ブロックを取り出す（最初に一致したもの） */
const ruleOf = (selector) => {
  const i = STYLE.indexOf(selector + '{');
  if (i < 0) return null;
  return STYLE.slice(i + selector.length + 1, STYLE.indexOf('}', i));
};

// ── scoped CSS の再発防止 ────────────────────────────────────────
test('style は is:global（scoped だと JS 生成の馬番チップへ適用されない）', () => {
  assert.match(PAGE, /<style is:global>/);
  assert.doesNotMatch(PAGE, /<style>\s/);
});

test('全セレクタが .ppr 名前空間に閉じている（他ページへの CSS 漏れ禁止）', () => {
  const bad = [];
  for (const raw of STYLE.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('/*') || line.startsWith('}') || line.startsWith('<')) continue;
    for (const m of line.matchAll(/(?:^|\{|\})\s*([^{}@/][^{}]*?)\{/g)) {
      for (const sel of m[1].split(',')) {
        const s = sel.trim();
        if (!s || s.startsWith('--')) continue;
        if (s === '.ppr' || s.startsWith('.ppr')) continue;
        bad.push(s);
      }
    }
  }
  assert.deepEqual(bad, [], '.ppr 名前空間の外にセレクタがある: ' + bad.join(' / '));
});

test('馬番チップは JS 生成である（= is:global が必須である根拠）', () => {
  assert.match(PAGE, /c\.innerHTML = Array\.from\(\{ length: 18 \}[\s\S]{0,120}class="chip"/);
});

// ── 馬番ボタン ───────────────────────────────────────────────────
test('馬番チップ: 未選択はダーク、選択中はゴールドで判別できる', () => {
  const off = ruleOf('.ppr .numpick .chip');
  assert.ok(off, '未選択スタイルが無い');
  assert.match(off, /background:linear-gradient\(180deg,#16233c,#101a2e\)/, '未選択がダークでない');
  assert.match(off, /color:var\(--ink-2\)/);
  assert.doesNotMatch(off, /background(-color)?:\s*(#fff|white)/i);

  const on = ruleOf('.ppr .numpick .chip.on');
  assert.ok(on, '選択中スタイルが無い');
  assert.match(on, /#f5c451/, '選択中がゴールドでない');
  assert.match(on, /color:#3a2a05/, '選択中の文字コントラストが無い');
});

test('馬番チップ: hover / focus-visible / disabled が定義されている', () => {
  assert.match(STYLE, /\.ppr \.numpick \.chip:hover:not\(\[disabled\]\)\{/);
  assert.match(STYLE, /\.ppr \.numpick \.chip:focus-visible\{[^}]*outline/);
  const dis = ruleOf('.ppr .numpick .chip[disabled]');
  assert.ok(dis, 'disabled スタイルが無い');
  assert.match(dis, /opacity/);
  assert.match(dis, /not-allowed/);
  assert.doesNotMatch(dis, /background(-color)?:\s*(#fff|white)/i, 'disabled で白背景へ戻している');
});

// ── フォーム全般 ─────────────────────────────────────────────────
test('button / select / input / textarea に既定のダーク配色がある', () => {
  assert.match(STYLE, /\.ppr button,\.ppr select,\.ppr input,\.ppr textarea\{[^}]*background-color:var\(--nv-2\)/);
  assert.match(STYLE, /\.ppr button,\.ppr select,\.ppr input,\.ppr textarea\{[^}]*color:var\(--ink\)/);
  assert.match(STYLE, /--nv-0:#0b1120/);
  assert.match(STYLE, /--gold:#f5c451/);
});

test('select は appearance:none + 自前シェブロン、option もダーク', () => {
  const sel = ruleOf('.ppr select');
  assert.ok(sel);
  assert.match(sel, /appearance:none/);
  assert.match(sel, /background-image:url\("data:image\/svg\+xml/);
  assert.match(STYLE, /\.ppr select option,\.ppr select optgroup\{[^}]*background-color:#0d1729/);
});

test('input はダーク背景 + muted placeholder + focus outline', () => {
  assert.match(STYLE, /\.ppr select,[^{]*input\[type=date\][^{]*\{background-color:var\(--nv-0\)\}/);
  assert.match(STYLE, /\.ppr input::placeholder\{color:#64748b\}/);
  assert.match(STYLE, /focus-visible\{outline:2px solid rgba\(245,196,81,\.6\)/);
  // date のカレンダーアイコンが暗背景で潰れない
  assert.match(STYLE, /calendar-picker-indicator\{filter:invert/);
});

test('checkbox は accent-color を AK ゴールドに（独自実装しない）', () => {
  const cb = ruleOf('.ppr input[type=checkbox]');
  assert.ok(cb, 'checkbox スタイルが無い');
  assert.match(cb, /accent-color:var\(--gold\)/);
  assert.doesNotMatch(STYLE, /input\[type=checkbox\][^{]*\{[^}]*appearance:none/, '独自 checkbox を作り込んでいる');
});

test('操作ボタン: 主要=ゴールド / 危険=ダーク赤（白背景を使わない）', () => {
  const primary = ruleOf('.ppr .actions .primary');
  assert.ok(primary);
  assert.match(primary, /#f5c451/);
  const danger = ruleOf('.ppr .actions .danger');
  assert.ok(danger);
  assert.match(danger, /background-color:#2a1416/);
  assert.match(danger, /color:#fca5a5/);
  assert.doesNotMatch(danger, /background:transparent/);
});

test('disabled でも白背景に戻らない', () => {
  const dis = ruleOf('.ppr button[disabled]');
  assert.ok(dis);
  assert.match(dis, /background-color:var\(--nv-2\)/);
  assert.match(dis, /not-allowed/);
});

// ── 白い標準 UI が残っていない ───────────────────────────────────
test('ページ自身のスタイルに白背景・黒文字の指定が無い', () => {
  const white = STYLE.match(/background(-color)?:\s*(#fff\b|#ffffff|white)/gi) || [];
  assert.deepEqual(white, [], '白背景の指定がある: ' + white.join(' / '));
  const black = STYLE.match(/color:\s*(#000\b|#000000|black)\s*[;}]/gi) || [];
  assert.deepEqual(black, [], '黒文字の指定がある: ' + black.join(' / '));
});

test('ビルド後の生成 CSS に scoped 不整合が無く、白 UI も混入しない（dist がある場合のみ）', (t) => {
  const dir = fileURLToPath(new URL('../../../dist/assets/', import.meta.url));
  if (!existsSync(dir)) return t.skip('dist 未生成（build 後に検証される）');
  const file = readdirSync(dir).find((f) => f.startsWith('premium-plus-results') && f.endsWith('.css'));
  if (!file) return t.skip('結果入力画面の CSS が dist に無い');
  const css = readFileSync(dir + file, 'utf8');

  assert.doesNotMatch(css, /data-astro-cid/, 'scoped 変換されている（JS 生成 DOM にスタイルが当たらない）');
  for (const sel of ['.ppr .numpick .chip', '.ppr .numpick .chip.on', '.ppr .actions .primary']) {
    assert.ok(css.includes(sel), `生成 CSS に無い: ${sel}`);
  }
  // 投票内容照会カード（.vref）は本物の控えを再現するため白背景が正しい。それ以外に白は許さない。
  const offenders = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    const decl = m[2];
    if (sel.includes('.vref')) continue;
    if (/background(-color)?:\s*(#fff\b|#ffffff|white)/i.test(decl)) offenders.push(sel);
    if (/color:\s*(#000\b|#000000|black)\s*(;|$)/i.test(decl)) offenders.push(sel);
  }
  assert.deepEqual(offenders, [], '入力 UI 側に白背景/黒文字が残っている: ' + offenders.join(' / '));
});

// ── 保存ロジック・契約に触れていない ────────────────────────────
test('保存 payload / API 契約を変更していない', () => {
  assert.match(PAGE, /const API = '\/\.netlify\/functions\/premium-plus-results'/);
  assert.match(PAGE, /'x-admin-secret'/);
  assert.match(PAGE, /action:\s*'upsert'|action: 'remove'|action/);
  // 判定・計算は単一源のまま
  assert.match(PAGE, /from '\.\.\/\.\.\/lib\/premiumPlusResults\.js'/);
  assert.match(PAGE, /renderReceiptCardHtml/);
});

test('プレビュー領域のカード CSS 単一源を維持', () => {
  assert.match(PAGE, /import '\.\.\/\.\.\/styles\/premiumPlusReceiptCard\.css'/);
  // .vref（本物の控え再現）を .ppr 名前空間で上書きしていない
  assert.doesNotMatch(STYLE, /\.vref/);
});
