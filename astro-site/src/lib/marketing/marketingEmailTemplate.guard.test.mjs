/**
 * marketingEmailTemplate.guard.test.mjs — HTML メール基盤の契約
 *   node --test src/lib/marketing/marketingEmailTemplate.guard.test.mjs
 *
 * 「文章だけを管理者が編集し、ブランド・特典・CTA・配信停止はシステムが組み立てる」
 * という分担が崩れないようにソース側で固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PAGE = read('../../pages/admin/premium-plus-eligibility.astro');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script is:inline>'));
const CATALOG = read('./campaignCatalog.js');
const SHELL = read('./marketingEmailShell.js');
const DISPATCH = read('../../../netlify/functions/marketing-campaign-dispatch.js');
const ADMIN = read('../../../netlify/functions/admin-marketing.js');

/** コメントを落とした「実際に動くコード」。禁止 URL を説明した注記を誤検知しない */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const sliceFrom = (src, marker, len = 2600) => {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `見つからない: ${marker}`);
  return src.slice(i, i + len);
};

// ── 描画は単一源 ────────────────────────────────────────────────

test('メール HTML はシェル 1 か所でしか組み立てない', () => {
  // カタログ側で <p style=...> のような組み立てを再実装しない
  assert.equal(/<p style="margin:0 0 1em/.test(CATALOG), false, 'カタログで HTML を組み立てている');
  assert.match(CATALOG, /renderMarketingEmail\(/, 'シェルへ委譲していない');
  // Function 側でも HTML を組み立てない
  for (const [name, src] of [['dispatch', DISPATCH], ['admin', ADMIN]]) {
    assert.equal(/<table role="presentation"/.test(src), false, `${name} で HTML を組み立てている`);
  }
});

test('HTML と text は必ず一緒に作る', () => {
  assert.match(SHELL, /export function renderMarketingEmail/, '同時生成の入口が無い');
  const fn = sliceFrom(SHELL, 'export function renderMarketingEmail', 400);
  assert.match(fn, /html: renderMarketingHtml/);
  assert.match(fn, /text: renderMarketingText/);
});

// ── 差し込みの安全性 ────────────────────────────────────────────

test('シェルは差し込む文字列を必ず escape する', () => {
  for (const fn of ['renderParagraphs', 'renderBadge', 'renderBenefitCard', 'renderCta', 'renderPreheader']) {
    const body = sliceFrom(SHELL, `export function ${fn}`, 1400);
    assert.match(body, /escapeHtml\(/, `${fn} が escape していない`);
  }
});

test('CTA の URL は許可 origin だけ通す', () => {
  assert.match(SHELL, /export const ALLOWED_LINK_ORIGINS/, '許可リストが無い');
  const cta = sliceFrom(SHELL, 'export function renderCta', 900);
  assert.match(cta, /if \(!isAllowedLink\(url\)\) return '';/, 'fail closed になっていない');
});

test('危険な要素をシェルが出力しない', () => {
  for (const bad of ['<script', '<iframe', '<form', '<video', '<svg', 'javascript:']) {
    // 文字列リテラルとして出力していないか（説明文のコメントは除く）
    const code = SHELL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(code.includes(`'${bad}`), false, `${bad} を出力している`);
  }
});

// ── 編集領域と固定領域の分離 ────────────────────────────────────

test('管理者が編集できるのは件名と本文だけ', () => {
  const draft = read('./campaignContentDraft.js');
  assert.match(draft, /HTML_NOT_ALLOWED/, 'HTML 入力を拒否していない');
  assert.match(draft, /URL_NOT_ALLOWED/, '本文の生 URL を拒否していない');
  // 下書きが持つのは subject / body だけ
  const norm = sliceFrom(draft, 'export function normalizeDraft', 500);
  assert.match(norm, /subject/);
  assert.match(norm, /body/);
  assert.equal(/ctaUrl|ctaLabel|benefitItems/.test(norm), false, '固定領域まで編集させている');
});

test('ブランド・特典・CTA・配信停止は本文編集で消えない', () => {
  // シェルが必ず出す要素（本文が空でも残る）
  for (const s of ['KEIBA Analytics', '配信を停止する', 'renderBenefitCard', 'renderCta']) {
    assert.ok(SHELL.includes(s), `${s} がシェルに無い`);
  }
});

// ── 配信停止 ────────────────────────────────────────────────────

test('配信停止はシェルの一部で、受信者ごとに差し替える', () => {
  assert.match(SHELL, /export const UNSUBSCRIBE_PLACEHOLDER/, '差し替え印が無い');
  const footer = sliceFrom(SHELL, 'function renderFooter', 900);
  assert.match(footer, /unsubscribeUrl/, 'フッターに配信停止が無い');
  assert.match(DISPATCH, /applyUnsubscribeUrl\(/, '送信側が差し替えていない');
});

test('配信停止を差し込めない本文は送らない（fail closed）', () => {
  const apply = sliceFrom(SHELL, 'export function applyUnsubscribeUrl', 500);
  assert.match(apply, /if \(!s\.includes\(UNSUBSCRIBE_PLACEHOLDER\)\) return null;/);
  assert.match(apply, /if \(!u\) return null;/);
  const send = sliceFrom(DISPATCH, 'async function sendOne', 1400);
  assert.match(send, /if \(!body\) return false;/, '差し替え失敗で送信を止めていない');
});

test('旧プロジェクトの配信変数を使わない', () => {
  for (const src of [SHELL, CATALOG, DISPATCH]) {
    assert.equal(/##__CANCEL_URL__##|##__prop_0__##/.test(src), false, '旧配信変数が残っている');
  }
});

// ── text/plain ──────────────────────────────────────────────────

test('SendGrid へ text/plain と text/html の 2 パートを渡す', () => {
  const send = sliceFrom(DISPATCH, 'async function sendOne', 2000);
  assert.match(send, /type: 'text\/plain'/, 'text/plain が無い');
  assert.match(send, /type: 'text\/html'/, 'text/html が無い');
  // RFC 2046: 後ろほど優先。html が後ろに来ていること
  assert.ok(send.indexOf("type: 'text/plain'") < send.indexOf("type: 'text/html'"),
    'html を text より前に置いている');
});

// ── 版管理 ──────────────────────────────────────────────────────

test('見た目の固定値も content hash の対象にする', () => {
  const snd = read('./campaignSend.js');
  const fn = sliceFrom(snd, 'export function computeCampaignContentHash', 1200);
  for (const f of ['preheader', 'badge', 'headline', 'benefitItems', 'ctaNote', 'footerNote']) {
    assert.ok(fn.includes(f), `${f} が版管理の対象になっていない`);
  }
  // 設定していないキャンペーンのハッシュは変えない
  assert.match(fn, /presentation\.some\(\(v\) => v !== ''\)/, '未設定でもハッシュを変えている');
});

test('Light 30日無料は v2 で、HTML の要素がそろっている', () => {
  const block = sliceFrom(CATALOG, "campaignId: 'comeback-light-30d-granted'", 2600);
  assert.match(block, /version: 2/, 'version を上げていない');
  for (const f of ['preheader:', 'badge:', 'headline:', 'benefitTitle:', 'benefitItems:', 'ctaNote:', 'footerNote:']) {
    assert.ok(block.includes(f), `${f} が無い`);
  }
  assert.match(block, /showGrantExpiry: true/, '無料期間の終了日を出さない設定になっている');
});

// ── 無料期間の終了日 ────────────────────────────────────────────

test('終了日は実際の権限状態から取る（本文の固定値で断定しない）', () => {
  const send = sliceFrom(DISPATCH, 'const expiryNote = describeGrantExpiry', 400);
  assert.match(send, /LightGrantUntil/, '実際の付与期限を見ていない');
  assert.match(send, /grantDurationDays/, '読めないときの代替が無い');
  const fn = sliceFrom(SHELL, 'export function describeGrantExpiry', 700);
  assert.match(fn, /return '';/, '読めないときに空を返していない');
});

// ── プレビュー ──────────────────────────────────────────────────

test('プレビューは送信と同じレンダラーで、サンプル値を使う', () => {
  const fn = sliceFrom(ADMIN, 'function buildPreview', 900);
  assert.match(fn, /renderCampaign\(\{/, '別実装で描いている');
  assert.match(fn, /PREVIEW_UNSUBSCRIBE_URL/, '実顧客の配信停止 URL を使っている');
  assert.match(fn, /name: PREVIEW_NAME/, 'サンプル宛名を使っていない');
});

test('プレビューは desktop / mobile / text を切り替えられる', () => {
  const block = sliceFrom(SCRIPT, "$('mkPreview')", 4000);
  assert.match(block, /デスクトップ幅/, 'デスクトップ表示が無い');
  assert.match(block, /モバイル幅/, 'モバイル表示が無い');
  assert.match(block, /テキスト版/, 'テキスト版が無い');
  assert.match(block, /sandbox/, 'iframe をサンドボックスにしていない');
  assert.match(block, /実際のお客様の情報は使っていません/, 'サンプルであることを伝えていない');
});

// ── 参考メールから持ち込まないもの ──────────────────────────────

test('旧ブランド・旧 URL・レース情報を持ち込まない', () => {
  for (const [name, raw] of [['shell', SHELL], ['catalog', CATALOG]]) {
    const src = codeOnly(raw);   // 禁止 URL を「使うな」と書いた注記は誤検知しない
    assert.equal(/NANKAN Analytics|nankan-analytics\.keiba\.link/.test(src), false, `${name} に旧ブランド`);
    assert.equal(/GI RACE|東京大賞典/.test(src), false, `${name} にレース情報`);
    assert.equal(/analytics\.keiba\.jp|netlify\.app/.test(src), false, `${name} に使用禁止 URL`);
  }
});

test('CTA を乱立させない（本文に生 URL を書かせない）', () => {
  const draft = read('./campaignContentDraft.js');
  assert.match(draft, /URL_NOT_ALLOWED/, '本文の URL を許している');
  // シェルが出すリンクは CTA と配信停止だけ
  const anchors = (SHELL.match(/<a href=/g) || []).length;
  assert.ok(anchors <= 2, `シェルが ${anchors} 本のリンクを出している`);
});
