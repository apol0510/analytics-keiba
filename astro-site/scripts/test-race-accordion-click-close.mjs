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
import { isOpenMaxHeight, shouldRestoreHeader, isCloseTransitionEnd } from '../src/lib/raceAccordionCloseScroll.js';

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

// ── close後スクロール復元: 静的検査（実装に必要な配線がソースに在るか） ──────────
console.log('\n[close後スクロール復元: 静的検査（実装↔テスト 乖離検出）]');
{
  const racePath = new URL('../src/components/RaceAccordionClickClose.astro', import.meta.url);
  const src = readFileSync(racePath, 'utf-8');
  const must = [
    ['共有判定モジュールを import', src.includes("from '../lib/raceAccordionCloseScroll.js'")],
    ['判定3関数を使用', src.includes('isOpenMaxHeight(') && src.includes('shouldRestoreHeader(') && src.includes('isCloseTransitionEnd(')],
    ['capture 段で登録（第3引数 true）', src.includes('    true,\n  );')],
    ['transitionend を待つ', src.includes("addEventListener('transitionend', onEnd)")],
    ['有限 fallback setTimeout', src.includes('window.setTimeout(finish, 500)')],
    ['二重実行ガード completed', src.includes('let completed = false') && src.includes('if (completed) return')],
    ["scrollIntoView block:'start'", src.includes("scrollIntoView({ block: 'start', behavior: 'auto' })")],
    ['新操作で保留 cancel', src.includes('cancelPending()') && src.includes('seq += 1')],
    ['seq 追い越しガード', src.includes('if (mySeq !== seq) return')],
  ];
  for (const [name, ok] of must) { if (ok) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name); } }
}

// ── close後スクロール復元: ロジック検査（実装と同一の共有純粋関数を直接実行） ──────
console.log('\n[close後スクロール復元: ロジック検査（実装と同一の共有関数を実行）]');
{
  // open/close 判定（実装が import している関数そのもの）
  check('open状態(none)→閉じる操作と判定', isOpenMaxHeight('none') === true);
  check('open状態(4233px)→閉じる操作と判定', isOpenMaxHeight('4233px') === true);
  check('closed状態(0px)→開く操作=予約しない', isOpenMaxHeight('0px') === false);
  check('closed状態(空)→開く操作=予約しない', isOpenMaxHeight('') === false);

  // 復元発火条件
  check('header上方(-1746)→復元する', shouldRestoreHeader(-1746) === true);
  check('header画面内(0)→復元しない', shouldRestoreHeader(0) === false);
  check('header画面内(120)→復元しない', shouldRestoreHeader(120) === false);

  // transitionend ガード
  const C = { id: 'content' }, child = { id: 'child' };
  check('target===content & max-height → 発火', isCloseTransitionEnd(C, C, 'max-height') === true);
  check('子要素の transitionend → 無視', isCloseTransitionEnd(child, C, 'max-height') === false);
  check('opacity の transitionend → 無視', isCloseTransitionEnd(C, C, 'opacity') === false);

  // 二重実行ガード（transitionend と fallback の両方が来ても1回）
  {
    let runs = 0, completed = false;
    const finish = () => { if (completed) return; completed = true; runs++; };
    finish(); finish();
    check('finish 二重呼び出しでも1回だけ', runs === 1);
  }

  // seq 追い越し（新操作で旧復元が無効化される）— 実装の finish と同じ seq ガードを再現
  {
    let restored = null;
    let seq = 0;
    const make = (mySeq, headerTop) => () => { if (mySeq !== seq) return; if (shouldRestoreHeader(headerTop)) restored = mySeq; };
    seq = 1; const oldFinish = make(1, -1746); // Y を閉じて予約
    seq = 2;                                    // X を開く=新操作で seq 進む
    oldFinish();                               // 旧 fallback が後から発火
    check('新操作後に旧復元 fallback が発火しても戻さない', restored === null);
    let restored2 = null; let seq2 = 5;
    const f = (() => { const my = seq2; return () => { if (my !== seq2) return; if (shouldRestoreHeader(-100)) restored2 = my; }; })();
    f();
    check('追い越されない通常closeは復元する', restored2 === 5);
  }
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
