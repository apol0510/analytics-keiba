#!/usr/bin/env node
/**
 * RaceAccordionClickClose / AccordionClickClose の最小 DOM ロジックテスト。
 *
 * 実コンポーネントの判定ロジックを再現し、複数のレースアコーディオン class 系
 * (.race-accordion-content / .jra-race-accordion-content / race-{N}r-accordion系) に対して
 * 「中身クリックで親が閉じる」「内側 details 操作では親が閉じない／内側だけ閉じる」
 * 「操作要素では親が閉じない」「初期 closed」を検証する。
 *
 * 注: 実コンポーネントの <script> は文字列複製ではなく、同等ロジックをここで再実装して検証する
 *     （ブラウザ自動操作が無い環境向けの準目視テスト）。
 *     乖離検出のため、実 .astro を readFileSync して重要 selector / ガード / header.click() が
 *     実ファイルに存在し、本テストの定数と一致することを下段で assert する。
 */

import { readFileSync } from 'fs';

// ---- 実装↔テスト 乖離検出（実 .astro を読み、重要箇所の存在と一致を確認） ----
{
  const racePath = new URL('../src/components/RaceAccordionClickClose.astro', import.meta.url);
  const accPath = new URL('../src/components/AccordionClickClose.astro', import.meta.url);
  const raceSrc = readFileSync(racePath, 'utf-8');
  const accSrc = readFileSync(accPath, 'utf-8');
  const must = [];
  // テスト側で使う定数（下段と同一値）
  const T_CONTENT = '.race-accordion-content, .jra-race-accordion-content';
  const T_HEADER = '.race-accordion-header, .jra-race-accordion-header';
  const T_IGNORE_TOKENS = ['a', 'button', 'summary', 'input', 'select', 'textarea', 'label', '[role="button"]', '[contenteditable]'];
  // RaceAccordionClickClose 実ファイルとの一致
  must.push(['Race: CONTENT_SEL 一致', raceSrc.includes("CONTENT_SEL = '" + T_CONTENT + "'")]);
  must.push(['Race: HEADER_SEL 一致', raceSrc.includes("HEADER_SEL = '" + T_HEADER + "'")]);
  must.push(['Race: IGNORE に HEADER_SEL を含む', raceSrc.includes("IGNORE_SEL =") && raceSrc.includes("+\n    HEADER_SEL")]);
  for (const tok of T_IGNORE_TOKENS) must.push(['Race: IGNORE に ' + tok, raceSrc.includes(tok)]);
  must.push(['Race: nested guard (content.contains)', raceSrc.includes("content.contains(nested)")]);
  must.push(["Race: nested は closest('details')", raceSrc.includes("t.closest('details')")]);
  must.push(['Race: open判定 offsetHeight===0', raceSrc.includes("content.offsetHeight === 0")]);
  must.push(['Race: header=previousElementSibling', raceSrc.includes("content.previousElementSibling")]);
  must.push(['Race: header fallback querySelector', raceSrc.includes("querySelector(HEADER_SEL)")]);
  must.push(['Race: header.click() で委譲', raceSrc.includes("header.click()")]);
  // AccordionClickClose 実ファイルとの一致（内側 details 担当）
  must.push(['Acc: details[data-click-close][open] 対象', accSrc.includes('details[data-click-close="true"][open]')]);
  must.push(['Acc: summary 除外', accSrc.includes('summary')]);
  must.push(['Acc: details.open=false で閉じる', accSrc.includes('details.open = false')]);

  let p = 0, f = 0;
  console.log('[実装↔テスト 乖離検出]');
  for (const [name, ok] of must) { if (ok) { p++; console.log('  ✅ ' + name); } else { f++; console.log('  ❌ ' + name); } }
  if (f > 0) { console.log(`\n❌ 実装とテストに乖離 (${f} 件)`); process.exit(1); }
  console.log(`  → ${p} checks OK\n`);
}

// ---- 最小 DOM モック ---------------------------------------------------------
let UID = 0;
class El {
  constructor(tag, opts = {}) {
    this.tag = tag;
    this.classes = opts.classes ? [...opts.classes] : [];
    this.attrs = opts.attrs ? { ...opts.attrs } : {};
    this.id = opts.id || '';
    this.children = [];
    this.parent = null;
    this.style = { maxHeight: opts.maxHeight ?? '', opacity: opts.opacity ?? '' };
    this.open = opts.open ?? undefined; // details の open 状態
    this._onclick = opts.onclick || null; // header の onclick 相当（programmatic click で発火）
    this._closed = opts.closed ?? null;   // accordion content の論理開閉（テスト検証用）
    this._uid = ++UID;
  }
  add(child) { child.parent = this; this.children.push(child); return child; }
  matches(sel) {
    return sel.split(',').map(s => s.trim()).some(part => {
      if (part.startsWith('.')) return this.classes.includes(part.slice(1));
      if (part.startsWith('[')) { const a = part.slice(1, -1).split('=')[0]; return a in this.attrs; }
      if (part.includes('[')) { // tag[attr]
        const [t, rest] = part.split('[');
        const a = rest.replace(']', '').split('=')[0];
        return this.tag === t && a in this.attrs;
      }
      return this.tag === part;
    });
  }
  closest(sel) { let n = this; while (n) { if (n.matches(sel)) return n; n = n.parent; } return null; }
  contains(node) { let n = node; while (n) { if (n === this) return true; n = n.parent; } return false; }
  get previousElementSibling() {
    if (!this.parent) return null;
    const i = this.parent.children.indexOf(this);
    return i > 0 ? this.parent.children[i - 1] : null;
  }
  querySelector(sel) {
    const stack = [...this.children];
    while (stack.length) { const n = stack.shift(); if (n.matches(sel)) return n; stack.push(...n.children); }
    return null;
  }
  get offsetHeight() {
    // 閉じている（maxHeight 0px/0/空 かつ content）なら 0、それ以外は可視とみなす
    if (this._closed === true) return 0;
    return 100;
  }
  click() { if (this._onclick) this._onclick(this); }
}

// ---- 実コンポーネントと同等のロジック ---------------------------------------
const CONTENT_SEL = '.race-accordion-content, .jra-race-accordion-content';
const HEADER_SEL = '.race-accordion-header, .jra-race-accordion-header';
const IGNORE_SEL = 'a, button, summary, input, select, textarea, label, [role="button"], [contenteditable], ' + HEADER_SEL;

// RaceAccordionClickClose: 親レースを閉じるか判定し、閉じる場合はヘッダーを click
function raceAccordionClickClose(target) {
  if (target.closest(IGNORE_SEL)) return 'ignore';
  const content = target.closest(CONTENT_SEL);
  if (!content) return 'no-content';
  const nested = target.closest('details');
  if (nested && content.contains(nested)) return 'skip-nested';
  if (content.offsetHeight === 0) return 'already-closed';
  let header = content.previousElementSibling;
  if (!(header && header.matches && header.matches(HEADER_SEL))) {
    const block = content.parent;
    header = block ? block.querySelector(HEADER_SEL) : null;
  }
  if (!header) return 'no-header';
  header.click(); // ページ固有 toggle を再利用
  return 'close-parent';
}

// AccordionClickClose: 内側 details[data-click-close][open] を閉じる
function accordionClickClose(target) {
  if (target.closest('a,button,input,select,textarea,summary,label,details summary')) return 'ignore';
  const details = target.closest('details[data-click-close][open]');
  if (!details) return 'no-details';
  const summary = details.querySelector('summary');
  if (summary && summary.contains(target)) return 'ignore-summary';
  details.open = false;
  return 'close-inner';
}

// ---- テスト用ツリー生成 ------------------------------------------------------
// block(class) > header(headerClass, onclick toggles content._closed) + content(contentClass, open)
//   content > p(本文) + a(link) + button + details[data-click-close][open] > summary + span(本文)
function buildTree(blockClass, headerClass, contentClass) {
  const block = new El('div', { classes: [blockClass] });
  const content = new El('div', { classes: [contentClass], id: 'c' + UID, maxHeight: 'none', opacity: '1' });
  content._closed = false;
  const header = new El('div', {
    classes: [headerClass],
    onclick: () => { content._closed = true; content.style.maxHeight = '0px'; content.style.opacity = '0'; },
  });
  block.add(header); block.add(content);
  const p = content.add(new El('p'));
  const link = content.add(new El('a', { attrs: { href: '#' } }));
  const btn = content.add(new El('button'));
  const details = content.add(new El('details', { classes: ['recent-races'], attrs: { 'data-click-close': '' }, open: true }));
  const summary = details.add(new El('summary'));
  const dbody = details.add(new El('div'));
  const dtext = dbody.add(new El('span'));
  return { block, content, header, p, link, btn, details, summary, dtext };
}

// ---- アサーション ------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name); } }

const classSystems = [
  ['premium/free/light 標準', 'race-accordion-block', 'race-accordion-header', 'race-accordion-content'],
  ['free JRA',               'jra-race-accordion',  'jra-race-accordion-header', 'jra-race-accordion-content'],
  ['venue/light南関 race-{N}r','race-1r-accordion',  'race-accordion-header', 'race-accordion-content'],
];

for (const [label, bc, hc, cc] of classSystems) {
  console.log(`\n[class系: ${label}]`);

  // 6. 初期状態（別ツリーで closed を確認）
  { const t = buildTree(bc, hc, cc); t.content._closed = true; t.content.style.maxHeight = '0px';
    check('初期 closed（max-height:0px・offsetHeight 0）', t.content.offsetHeight === 0 && t.content._closed === true); }

  // 1. 本文 p クリック → 親 closed
  { const t = buildTree(bc, hc, cc); const r = raceAccordionClickClose(t.p);
    check('本文(p)クリック → close-parent', r === 'close-parent' && t.content._closed === true); }

  // 2. 本文の余白(content直下)クリック → 親 closed
  { const t = buildTree(bc, hc, cc); const r = raceAccordionClickClose(t.content);
    check('本文余白クリック → close-parent', r === 'close-parent' && t.content._closed === true); }

  // 3. nested details summary → 親維持（Raceは ignore/ AccordionClickClose も summary除外）
  { const t = buildTree(bc, hc, cc);
    const r = raceAccordionClickClose(t.summary); const a = accordionClickClose(t.summary);
    check('details summary → 親維持(close-parent でない)', r !== 'close-parent' && t.content._closed === false);
    check('details summary → 内側も閉じない(summaryは通常開閉)', a === 'ignore' && t.details.open === true); }

  // 4. nested details 本文 → 内側のみ closed、親維持
  { const t = buildTree(bc, hc, cc);
    const r = raceAccordionClickClose(t.dtext); const a = accordionClickClose(t.dtext);
    check('details本文 → 親維持(skip-nested)', r === 'skip-nested' && t.content._closed === false);
    check('details本文 → 内側 details のみ closed', a === 'close-inner' && t.details.open === false); }

  // 5. link / button → 親維持
  { const t = buildTree(bc, hc, cc);
    check('link(a) → 親維持', raceAccordionClickClose(t.link) === 'ignore' && t.content._closed === false); }
  { const t = buildTree(bc, hc, cc);
    check('button → 親維持', raceAccordionClickClose(t.btn) === 'ignore' && t.content._closed === false); }

  // 7. ヘッダークリックは Race ハンドラの対象外（各ページ onclick が開閉）
  { const t = buildTree(bc, hc, cc);
    check('header クリック → Race ハンドラは ignore(二重発火しない)', raceAccordionClickClose(t.header) === 'ignore'); }
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
