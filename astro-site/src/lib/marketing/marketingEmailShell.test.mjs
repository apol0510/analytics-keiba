/**
 * marketingEmailShell.test.mjs
 *   node --test src/lib/marketing/marketingEmailShell.test.mjs
 *
 * メールは送ったら取り消せない。**注入・配信停止の欠落・崩れ**を出さないことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UNSUBSCRIBE_PLACEHOLDER, GRANT_EXPIRY_PLACEHOLDER, PREVIEW_UNSUBSCRIBE_URL,
  ALLOWED_LINK_ORIGINS, EMAIL_WIDTH, BRAND,
  escapeHtml, isAllowedLink, renderParagraphs, renderPreheader, renderBadge,
  renderBenefitCard, renderCta, describeGrantExpiry,
  renderMarketingHtml, renderMarketingText, renderMarketingEmail,
  applyUnsubscribeUrl, applyGrantExpiry, plainTextFromMarketingHtml,
} from './marketingEmailShell.js';

const CTA = { label: 'KEIBA Analyticsにログイン', url: 'https://analytics.keiba.link/dashboard/' };
const base = (over = {}) => ({
  salutation: '山田 様',
  badge: '30日間無料',
  headline: 'Lightプランを30日間無料でご利用いただけます',
  preheader: 'お申し込み不要。すぐにご利用いただけます。',
  body: '本文の一段落目です。\n2 行目です。\n\n二段落目です。',
  benefit: { title: 'Lightプラン（30日間無料）', items: ['メインレース買い目', 'お支払い不要'] },
  cta: CTA,
  ctaNote: 'お申し込み手続きは必要ありません。',
  ...over,
});

// ── escape / 注入 ──────────────────────────────────────────────

test('HTML 特殊文字を escape する', () => {
  assert.equal(escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
});

test('script / style / イベントハンドラを注入できない', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(1)><style>body{}</style>';
  const r = renderMarketingEmail(base({
    salutation: evil, headline: evil, badge: evil, body: evil,
    benefit: { title: evil, items: [evil] }, ctaNote: evil,
  }));
  // 危険なのは「タグとして解釈されること」。escape 済みの文字列として
  // 本文に現れるのは無害なので、**タグの形になっていないこと**を見る。
  for (const bad of ['<script', '<img', '<style>body']) {
    assert.equal(r.html.includes(bad), false, `${bad} がタグとして残っている`);
  }
  assert.equal(/<[^>]*\son[a-z]+=/.test(r.html), false, 'イベントハンドラ属性が入っている');
  assert.ok(r.html.includes('&lt;script&gt;'), 'escape された形になっていない');
});

test('属性を抜けられない（引用符の escape）', () => {
  const r = renderMarketingHtml(base({ headline: '" onmouseover="alert(1)' }));
  assert.equal(r.includes('onmouseover="alert'), false);
  assert.ok(r.includes('&quot;'));
});

test('CTA ラベルの注入も防ぐ', () => {
  const r = renderCta({ label: '<script>x</script>', url: CTA.url });
  assert.equal(r.includes('<script>'), false);
  assert.ok(r.includes('&lt;script&gt;'));
});

// ── リンクの許可 ────────────────────────────────────────────────

test('許可した origin の URL だけを CTA にする', () => {
  assert.equal(isAllowedLink('https://analytics.keiba.link/dashboard/'), true);
  assert.equal(isAllowedLink('https://analytics.keiba.link'), true);
  for (const bad of [
    'https://evil.example.com/', 'javascript:alert(1)', 'http://analytics.keiba.link/',
    'https://analytics.keiba.jp/', 'https://analytics.keiba.link.evil.com/', '',
  ]) {
    assert.equal(isAllowedLink(bad), false, `${bad} を通している`);
  }
});

test('許可外の URL では CTA ボタンを出さない（fail closed）', () => {
  assert.equal(renderCta({ label: 'x', url: 'https://evil.example.com/' }), '');
  assert.equal(renderCta({ label: 'x', url: 'javascript:alert(1)' }), '');
  const r = renderMarketingEmail(base({ cta: { label: 'x', url: 'javascript:alert(1)' } }));
  assert.equal(r.html.includes('javascript:'), false);
  assert.equal(r.text.includes('javascript:'), false);
});

test('送信直前に差し替わる専用 URL の印は通す', () => {
  assert.equal(isAllowedLink('{{offerUrl}}'), true);
  assert.ok(renderCta({ label: '申込', url: '{{offerUrl}}' }).includes('{{offerUrl}}'));
});

// ── 段落変換 ────────────────────────────────────────────────────

test('空行で段落、単一改行で <br /> になる', () => {
  const html = renderParagraphs('あ\nい\n\nう');
  assert.equal((html.match(/<p /g) || []).length, 2);
  assert.ok(html.includes('あ<br />い'));
  assert.ok(html.includes('>う<'));
});

test('段落変換でも escape する', () => {
  assert.ok(renderParagraphs('<b>x</b>').includes('&lt;b&gt;'));
});

test('空本文でも落ちない', () => {
  assert.equal(renderParagraphs(''), '');
  assert.equal(renderParagraphs(null), '');
});

// ── 構造 ────────────────────────────────────────────────────────

test('600px の table レイアウトで、flex / grid を使わない', () => {
  const html = renderMarketingHtml(base());
  assert.ok(html.includes(`width="${EMAIL_WIDTH}"`), '600px の table が無い');
  assert.ok(html.includes(`max-width:${EMAIL_WIDTH}px`));
  assert.equal(/display:\s*(flex|grid)/.test(html), false, 'flex / grid を使っている');
  assert.ok(html.includes('role="presentation"'), 'レイアウト table に role が無い');
});

test('外部リソースに依存しない（画像・Web フォント・SVG・JS なし）', () => {
  const html = renderMarketingHtml(base());
  for (const bad of ['<img', '<svg', '<script', '@font-face', 'https://fonts.', '<link']) {
    assert.equal(html.includes(bad), false, `${bad} に依存している`);
  }
});

test('文字色を必ず指定する（ダークモードで消えない）', () => {
  const html = renderMarketingHtml(base());
  assert.ok(html.includes(`color:${BRAND.text}`), '本文の文字色が無い');
  assert.ok(html.includes(`bgcolor="${BRAND.headerBg}"`), 'ヘッダーの背景色が無い');
});

test('モバイル用のメディアクエリは 1 つだけ（効かなくても読める）', () => {
  const html = renderMarketingHtml(base());
  assert.equal((html.match(/@media/g) || []).length, 1);
  assert.ok(html.includes('max-width:600px'));
});

test('ブランドは KEIBA Analytics / analytics.keiba.link だけ', () => {
  const r = renderMarketingEmail(base());
  for (const s of [r.html, r.text]) {
    assert.ok(s.includes('KEIBA Analytics'));
    assert.equal(/NANKAN|nankan-analytics/i.test(s), false, '旧ブランドが混ざっている');
    assert.equal(/analytics\.keiba\.jp|netlify\.app/.test(s), false, '使用禁止 URL がある');
    assert.equal(/##__|prop_0|CANCEL_URL/.test(s), false, '旧配信変数が混ざっている');
  }
  assert.deepEqual(ALLOWED_LINK_ORIGINS, ['https://analytics.keiba.link']);
});

test('プリヘッダーは本文に見えない形で入る', () => {
  const html = renderMarketingHtml(base());
  assert.ok(html.includes('display:none'), 'プリヘッダーが隠れていない');
  assert.ok(html.includes('お申し込み不要'));
  assert.equal(renderPreheader(''), '');
});

test('バッジ・特典カードは値が無ければ出さない', () => {
  assert.equal(renderBadge(''), '');
  assert.equal(renderBenefitCard({}), '');
  assert.equal(renderBenefitCard({ items: [] }), '');
  assert.ok(renderBenefitCard({ title: 'A', items: ['x'] }).includes('A'));
});

// ── 無料期間の終了日 ────────────────────────────────────────────

test('終了日が読めれば日付で出す（JST）', () => {
  assert.equal(
    describeGrantExpiry({ expiresAt: '2026-09-02T14:59:59.000Z' }),
    '無料でご利用いただけるのは 2026年9月2日 までです。',
  );
});

test('終了日が読めなければ日付を断定せず日数で言う', () => {
  assert.equal(describeGrantExpiry({ durationDays: 30 }), '無料でご利用いただけるのは付与日から 30 日間です。');
  assert.equal(describeGrantExpiry({ expiresAt: 'not-a-date', durationDays: 30 }),
    '無料でご利用いただけるのは付与日から 30 日間です。');
});

test('どちらも読めなければ何も言わない（嘘の期限を書かない）', () => {
  assert.equal(describeGrantExpiry({}), '');
  assert.equal(describeGrantExpiry(), '');
});

test('終了日は差し替えでき、空なら段落ごと消える', () => {
  const html = renderMarketingHtml(base({ expiryNote: GRANT_EXPIRY_PLACEHOLDER }));
  assert.ok(html.includes(GRANT_EXPIRY_PLACEHOLDER));
  const filled = applyGrantExpiry(html, '無料は 2026年9月2日 までです。');
  assert.ok(filled.includes('2026年9月2日'));
  assert.equal(filled.includes(GRANT_EXPIRY_PLACEHOLDER), false);
  const removed = applyGrantExpiry(html, '');
  assert.equal(removed.includes(GRANT_EXPIRY_PLACEHOLDER), false, '印が残っている');
  assert.equal(removed.includes('までです'), false);
});

// ── 配信停止 ────────────────────────────────────────────────────

test('配信停止の印は HTML と text の両方に必ず入る', () => {
  const r = renderMarketingEmail(base());
  assert.ok(r.html.includes(UNSUBSCRIBE_PLACEHOLDER));
  assert.ok(r.text.includes(UNSUBSCRIBE_PLACEHOLDER));
  assert.ok(r.html.includes('配信を停止する'));
  assert.ok(r.text.includes('配信を停止する'));
});

test('受信者ごとの配信停止 URL に差し替えられる', () => {
  const r = renderMarketingEmail(base());
  const url = 'https://analytics.keiba.link/.netlify/functions/unsubscribe?email=a%40b.c&brand=analytics-keiba';
  const html = applyUnsubscribeUrl(r.html, url);
  assert.ok(html.includes(url));
  assert.equal(html.includes(UNSUBSCRIBE_PLACEHOLDER), false);
  assert.ok(applyUnsubscribeUrl(r.text, url).includes(url));
});

test('印が無い / URL が無い本文は差し替えられない（fail closed）', () => {
  assert.equal(applyUnsubscribeUrl('<p>印の無い本文</p>', 'https://x'), null);
  assert.equal(applyUnsubscribeUrl(renderMarketingHtml(base()), ''), null);
  assert.equal(applyUnsubscribeUrl('', 'https://x'), null);
});

test('プレビュー用の配信停止 URL は実顧客のものではない', () => {
  assert.equal(/email=/.test(PREVIEW_UNSUBSCRIBE_URL), false);
  assert.ok(PREVIEW_UNSUBSCRIBE_URL.startsWith('https://analytics.keiba.link'));
});

// ── text/plain ──────────────────────────────────────────────────

test('HTML と text を同時に返す', () => {
  const r = renderMarketingEmail(base());
  assert.ok(r.html.length > 500);
  assert.ok(r.text.length > 50);
});

test('text 版に宛名・見出し・本文・特典・CTA・配信停止・署名がそろう', () => {
  const t = renderMarketingText(base());
  assert.ok(t.startsWith('山田 様'), '宛名が先頭に無い');
  assert.ok(t.includes('［30日間無料］'));
  assert.ok(t.includes('Lightプランを30日間無料'));
  assert.ok(t.includes('本文の一段落目です。'));
  assert.ok(t.includes('・メインレース買い目'));
  assert.ok(t.includes(CTA.url), 'CTA の URL が無い');
  assert.ok(t.includes('— KEIBA Analytics'));
  assert.ok(t.includes(UNSUBSCRIBE_PLACEHOLDER));
  assert.equal(t.includes('<'), false, 'テキスト版にタグが混ざっている');
});

test('保存済み HTML から作った text も同じ要素を含む', () => {
  const r = renderMarketingEmail(base());
  const derived = plainTextFromMarketingHtml(r.html);
  for (const s of ['山田 様', 'Lightプランを30日間無料', '本文の一段落目です。', CTA.url]) {
    assert.ok(derived.includes(s), `derived text に ${s} が無い`);
  }
  assert.equal(derived.includes('<'), false, 'タグが残っている');
  // プリヘッダーは本文に出さない（受信箱の一覧用）
  assert.equal(derived.includes('お申し込み不要。すぐに'), false, 'プリヘッダーが本文に出ている');
});

// ── 崩れにくさ ──────────────────────────────────────────────────

test('長い日本語の件名・本文でも崩れない', () => {
  const long = 'あ'.repeat(400);
  const r = renderMarketingEmail(base({ body: long, headline: long }));
  assert.ok(r.html.includes('あ'.repeat(50)));
  assert.equal(/<p[^>]*><\/p>/.test(r.html), false, '空段落が生まれている');
});

test('本文が空でもシェルは成立する（CTA と配信停止が残る）', () => {
  const r = renderMarketingEmail(base({ body: '', benefit: null }));
  assert.ok(r.html.includes(CTA.url));
  assert.ok(r.html.includes(UNSUBSCRIBE_PLACEHOLDER));
  assert.ok(r.text.includes(UNSUBSCRIBE_PLACEHOLDER));
});

test('CTA は 1 つだけ（乱立させない）', () => {
  const r = renderMarketingHtml(base());
  const anchors = (r.match(/<a /g) || []).length;
  // CTA ボタン + フッターの配信停止 = 2
  assert.equal(anchors, 2, `リンクが ${anchors} 本ある（CTA と配信停止だけにする）`);
});
