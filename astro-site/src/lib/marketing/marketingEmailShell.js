/**
 * marketingEmailShell.js — AK キャンペーンメールの共通 HTML シェル（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * これまでのキャンペーンメールは `<div>` に段落を並べ、青いボタンを 1 つ置いただけだった。
 * 情報は正しいが「読む気にならない」見た目で、特典の価値が伝わらない。
 * 一方で、管理者に HTML を書かせると崩れ・注入・配信停止の欠落が起きる。
 *
 * そこで **文章だけを管理者が編集し、構造・ブランド・特典・CTA・配信停止は
 * システムが組み立てる** 形に分ける。
 *
 * ── メールクライアント互換の方針 ──────────────────────────────────
 *   - レイアウトは **table**（flex / grid は使わない）
 *   - 装飾は **inline CSS**。`<style>` はモバイル用のメディアクエリ 1 つだけ
 *   - `border-radius` は Outlook で無視されるが、**角が四角くなるだけ**で読める
 *   - VML は使わない（角丸ボタンのためだけに Outlook 専用マークアップを増やさない）
 *   - 画像・Web フォント・SVG・JavaScript・外部 CSS に依存しない（画像なしで成立）
 *   - 本文の色は必ず指定する（ダークモードで文字が消えないように）
 *
 * ── 安全性 ────────────────────────────────────────────────────
 *   - 差し込む文字列は**すべて escape**する（`<script>` も属性抜けも通さない）
 *   - URL は許可した origin だけ通す。それ以外は CTA を出さない（fail closed）
 *   - 配信停止は**シェルの一部**。印が消えていたら送信側が止める
 *     （`UNSUBSCRIBE_PLACEHOLDER` / `applyUnsubscribeUrl`）
 *
 * ⚠️ 本文に生 URL は書かせない（`campaignContentDraft.js` が拒否する）。
 *    リンクは CTA ボタン 1 つに集約する。
 */

/**
 * ── シェルの版 ────────────────────────────────────────────────
 * このファイルが出力する **HTML / text の構造そのもの**の版。
 *
 * campaign の `version` は「文面（件名・本文・特典・CTA）の版」で、
 * こちらは「**組み立て方**の版」。両方が届くメールを決めるので、
 * どちらか一方でも変われば受け取る人にとっては別物になる。
 *
 * ⚠️ **マークアップ・配色・差し替え印・text の組み立てを変えたら必ず上げること。**
 *    上げないと、
 *      - dry-run で確認した HTML と、deploy 後にキュー登録される HTML が食い違う
 *      - `computeCampaignContentHash` が同じ値のまま、実際の中身だけ変わる
 *    という「確認した内容と違うメールを送る」事故になる。
 *
 * 版を上げたときにすること:
 *   1. `campaignCatalog.test.mjs` の LOCKED を更新（全キャンペーンのハッシュが変わる）
 *   2. 送信待ち（PENDING）のジョブは**古い版で作られている**ので、
 *      dispatcher が送信を拒否する。dry-run からやり直して積み直す
 */
export const MARKETING_EMAIL_SHELL_VERSION = 1;

/** ジョブの Notes へ残す印（dispatcher がここから読んで照合する） */
export const SHELL_VERSION_NOTE_PREFIX = 'shell:v';

/** Notes からシェル版を読む。読めなければ null（＝古い形式 / 不明） */
export function readShellVersionFromNote(note) {
  const m = String(note ?? '').match(/shell:v(\d+)/);
  return m ? Number(m[1]) : null;
}

/** 送信側が受信者ごとに差し替える印。**HTML と text の両方に必ず 1 つ入る** */
export const UNSUBSCRIBE_PLACEHOLDER = '{{unsubscribeUrl}}';

/**
 * 無料期間の終了日の印。受信者ごとに違うので、送信側が 1 通ずつ差し替える。
 * 差し替えられなかった場合は**印ごと取り除く**（嘘の期限を出さない）。
 */
export const GRANT_EXPIRY_PLACEHOLDER = '{{grantExpiry}}';

/** プレビューで使うダミー（本番 URL でも実顧客のものでもない） */
export const PREVIEW_UNSUBSCRIBE_URL = 'https://analytics.keiba.link/unsubscribe-preview';

/** リンクを許可する origin。ここに無い URL は CTA として出さない */
export const ALLOWED_LINK_ORIGINS = Object.freeze(['https://analytics.keiba.link']);

/**
 * 送信直前に差し替わる URL の印。**この時点では実 URL が無いのが正しい**。
 * 実 URL は差し替え側（`offerCampaignLink.js`）が自前の SITE から組み立てるので、
 * ここで通しても外部ドメインへは飛ばない。
 */
export const DEFERRED_LINK_PLACEHOLDERS = Object.freeze(['{{offerUrl}}']);

/** メール本文の最大幅（px）。600 前後が各クライアントで最も安全 */
export const EMAIL_WIDTH = 600;

/**
 * AK のブランド色。管理 UI（濃紺・青・緑・金）と揃える。
 * 赤を主役にしない／煽らない、という方針をここで固定する。
 */
export const BRAND = Object.freeze({
  outerBg: '#eef2f7',      // 外側の背景（明るいグレー）
  cardBg: '#ffffff',
  headerBg: '#16264a',     // 濃紺
  headerText: '#ffffff',
  accent: '#2563eb',       // 青（CTA・強調）
  accentRule: '#38bdf8',   // ヘッダー下の細いライン
  benefitBg: '#ecfdf5',    // 特典カード（緑系＝無料・安心）
  benefitBorder: '#10b981',
  benefitText: '#065f46',
  badgeBg: '#fef3c7',      // バッジ（金系）
  badgeText: '#92400e',
  text: '#1f2937',
  textMuted: '#5b6472',
  footerBg: '#f8fafc',
  footerText: '#64748b',
  hairline: '#e2e8f0',
});

const str = (v) => String(v ?? '');

/** HTML へ入れてよい形にする。**属性値にもそのまま使える** */
export function escapeHtml(value) {
  return str(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * リンクとして通してよい URL か。
 * 許可 origin 以外・`javascript:` などは**通さない**（fail closed）。
 */
export function isAllowedLink(url) {
  const u = str(url).trim();
  if (!u) return false;
  if (ALLOWED_LINK_ORIGINS.some((o) => u === o || u.startsWith(`${o}/`))) return true;
  // 送信直前に差し替わる印はそのまま通す（差し替え側が実 URL を作る）
  return DEFERRED_LINK_PLACEHOLDERS.some((ph) => u === ph || u.includes(ph));
}

/**
 * 本文（プレーンテキスト）を段落へ。
 *   空行 … 段落の区切り
 *   単一改行 … `<br />`
 * 文字は必ず escape する。
 */
export function renderParagraphs(text, { color = BRAND.text, size = '15px' } = {}) {
  const blocks = str(text).replace(/\r\n?/g, '\n').split(/\n{2,}/)
    .map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split('\n').map((l) => escapeHtml(l)).join('<br />');
    return `<p style="margin:0 0 16px;padding:0;font-size:${size};line-height:1.9;color:${color};">${lines}</p>`;
  }).join('\n');
}

/** 受信箱の一覧に出る短い説明。本文には見せない（表示領域を潰さない） */
export function renderPreheader(text) {
  const t = escapeHtml(str(text).trim());
  if (!t) return '';
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.outerBg};">${t}</div>`;
}

/** 種別バッジ（「30日間無料」など）。無ければ何も出さない */
export function renderBadge(label) {
  const t = escapeHtml(str(label).trim());
  if (!t) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;">`
    + `<tr><td style="background:${BRAND.badgeBg};color:${BRAND.badgeText};font-size:13px;font-weight:bold;`
    + `padding:6px 14px;border-radius:14px;">${t}</td></tr></table>`;
}

/**
 * 特典カード。**何がどれだけ無料なのか**を箇条書きで見せる。
 * 中身はテンプレート側の固定値で、管理者の本文編集では変わらない。
 */
export function renderBenefitCard({ title, items } = {}) {
  const rows = (Array.isArray(items) ? items : []).map((i) => str(i).trim()).filter(Boolean);
  const heading = escapeHtml(str(title).trim());
  if (!heading && rows.length === 0) return '';
  const lis = rows.map((i) => (
    `<tr><td style="padding:3px 0;font-size:15px;line-height:1.7;color:${BRAND.benefitText};">`
    + `<span style="color:${BRAND.benefitBorder};font-weight:bold;">✓</span>&nbsp;${escapeHtml(i)}</td></tr>`
  )).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px;">`
    + `<tr><td style="background:${BRAND.benefitBg};border-left:4px solid ${BRAND.benefitBorder};padding:16px 18px;border-radius:6px;">`
    + (heading ? `<p style="margin:0 0 8px;font-size:16px;font-weight:bold;color:${BRAND.benefitText};">${heading}</p>` : '')
    + (lis ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${lis}</table>` : '')
    + `</td></tr></table>`;
}

/**
 * CTA ボタン。**table セルの背景色**で作る（Outlook でも塗りが出る）。
 * 角丸は非対応クライアントでは四角くなるだけで読める。
 * URL が許可 origin でなければ**ボタンを出さない**。
 */
export function renderCta({ label, url } = {}) {
  const text = escapeHtml(str(label).trim() || '詳細を見る');
  if (!isAllowedLink(url)) return '';
  const href = escapeHtml(str(url).trim());
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 10px;">`
    + `<tr><td align="center">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0">`
    + `<tr><td align="center" bgcolor="${BRAND.accent}" style="border-radius:6px;">`
    + `<a href="${href}" target="_blank" rel="noopener"`
    + ` style="display:inline-block;padding:15px 32px;font-size:16px;font-weight:bold;`
    + `color:#ffffff;text-decoration:none;border-radius:6px;">${text}</a>`
    + `</td></tr></table>`
    + `</td></tr></table>`;
}

/** ブランドヘッダー（濃紺 + 細いアクセントライン） */
function renderHeader() {
  return `<tr><td align="center" bgcolor="${BRAND.headerBg}" style="padding:26px 24px 20px;">`
    + `<p style="margin:0;font-size:22px;font-weight:bold;color:${BRAND.headerText};letter-spacing:.04em;">KEIBA Analytics</p>`
    + `<p style="margin:6px 0 0;font-size:12px;color:#b9c6e0;">南関競馬・中央競馬 AI 予想</p>`
    + `</td></tr>`
    + `<tr><td style="height:4px;line-height:4px;font-size:0;background:${BRAND.accentRule};">&nbsp;</td></tr>`;
}

/** フッター（署名 + サイト + 配信停止） */
function renderFooter({ footerNote, unsubscribeUrl }) {
  const note = str(footerNote).trim();
  const href = escapeHtml(str(unsubscribeUrl));
  return `<tr><td bgcolor="${BRAND.footerBg}" style="padding:20px 24px;border-top:1px solid ${BRAND.hairline};">`
    + (note ? `<p style="margin:0 0 10px;font-size:12px;line-height:1.8;color:${BRAND.footerText};">${escapeHtml(note)}</p>` : '')
    + `<p style="margin:0 0 6px;font-size:12px;line-height:1.8;color:${BRAND.footerText};">`
    + `KEIBA Analytics<br />https://analytics.keiba.link</p>`
    + `<p style="margin:10px 0 0;font-size:12px;line-height:1.8;">`
    + `<a href="${href}" style="color:${BRAND.footerText};text-decoration:underline;">配信を停止する</a>`
    + `</p></td></tr>`;
}

/**
 * 無料期間の終了日の文言。
 *
 * **実際の権限状態が正本**。終了日が読めないときは日付を断定せず
 * 「付与日から◯日間」とだけ言う（嘘の期限を書かない）。
 */
export function describeGrantExpiry({ expiresAt, durationDays } = {}) {
  const raw = str(expiresAt).trim();
  const t = raw ? Date.parse(raw) : NaN;
  if (Number.isFinite(t)) {
    const d = new Date(t);
    const jst = new Date(d.getTime() + 9 * 3600000);
    const y = jst.getUTCFullYear();
    const m = jst.getUTCMonth() + 1;
    const day = jst.getUTCDate();
    return `無料でご利用いただけるのは ${y}年${m}月${day}日 までです。`;
  }
  const days = Number(durationDays);
  if (Number.isFinite(days) && days > 0) return `無料でご利用いただけるのは付与日から ${days} 日間です。`;
  return '';
}

/**
 * 本文 HTML を組み立てる。
 *
 * @param {{
 *   salutation?: string, badge?: string, headline?: string, preheader?: string,
 *   body?: string, benefit?: {title?: string, items?: string[]},
 *   cta?: {label?: string, url?: string}, ctaNote?: string,
 *   expiryNote?: string, footerNote?: string, unsubscribeUrl?: string,
 * }} input
 */
export function renderMarketingHtml(input = {}) {
  const {
    salutation, badge, headline, preheader, body, benefit, cta, ctaNote,
    expiryNote, footerNote, unsubscribeUrl = UNSUBSCRIBE_PLACEHOLDER,
  } = input;

  const inner = [
    salutation
      ? `<p style="margin:0 0 18px;font-size:15px;line-height:1.9;color:${BRAND.text};">${escapeHtml(salutation)}</p>`
      : '',
    renderBadge(badge),
    headline
      ? `<h1 class="ak-h1" style="margin:0 0 16px;font-size:20px;line-height:1.6;font-weight:bold;color:${BRAND.text};">${escapeHtml(headline)}</h1>`
      : '',
    renderParagraphs(body),
    renderBenefitCard(benefit || {}),
    expiryNote
      ? `<p style="margin:0 0 18px;font-size:14px;line-height:1.8;color:${BRAND.textMuted};">${escapeHtml(expiryNote)}</p>`
      : '',
    renderCta(cta || {}),
    ctaNote
      ? `<p style="margin:4px 0 0;font-size:13px;line-height:1.8;color:${BRAND.textMuted};text-align:center;">${escapeHtml(ctaNote)}</p>`
      : '',
  ].filter(Boolean).join('\n');

  // モバイルでの余白・文字サイズだけを調整する。これが効かなくても本文は読める
  const style = '<style>@media only screen and (max-width:600px){'
    + '.ak-wrap{width:100% !important;}'
    + '.ak-pad{padding:20px 16px !important;}'
    + '.ak-h1{font-size:19px !important;}'
    + '}</style>';

  return [
    style,
    renderPreheader(preheader),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.outerBg}" style="background:${BRAND.outerBg};margin:0;padding:0;">`,
    `<tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" class="ak-wrap" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0"`,
    ` style="width:${EMAIL_WIDTH}px;max-width:${EMAIL_WIDTH}px;background:${BRAND.cardBg};border-radius:8px;overflow:hidden;`,
    `font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Yu Gothic',Meiryo,sans-serif;">`,
    renderHeader(),
    `<tr><td class="ak-pad" style="padding:26px 28px 22px;">`,
    inner,
    `</td></tr>`,
    renderFooter({ footerNote, unsubscribeUrl }),
    `</table>`,
    `</td></tr></table>`,
  ].filter(Boolean).join('\n');
}

/** 同じ内容の text/plain 版。HTML を読めない環境でも同じことが伝わるようにする */
export function renderMarketingText(input = {}) {
  const {
    salutation, badge, headline, body, benefit, cta, ctaNote,
    expiryNote, footerNote, unsubscribeUrl = UNSUBSCRIBE_PLACEHOLDER,
  } = input;

  const lines = [];
  if (salutation) lines.push(str(salutation).trim(), '');
  if (badge) lines.push(`［${str(badge).trim()}］`);
  if (headline) lines.push(str(headline).trim(), '');
  const text = str(body).replace(/\r\n?/g, '\n').trim();
  if (text) lines.push(text, '');

  const items = (benefit && Array.isArray(benefit.items) ? benefit.items : [])
    .map((i) => str(i).trim()).filter(Boolean);
  if ((benefit && benefit.title) || items.length) {
    lines.push('──────────');
    if (benefit && benefit.title) lines.push(str(benefit.title).trim());
    for (const i of items) lines.push(`・${i}`);
    lines.push('──────────', '');
  }
  if (expiryNote) lines.push(str(expiryNote).trim(), '');
  if (cta && isAllowedLink(cta.url)) {
    lines.push(`${str(cta.label).trim() || '詳細'}:`, str(cta.url).trim(), '');
  }
  if (ctaNote) lines.push(str(ctaNote).trim(), '');
  if (footerNote) lines.push(str(footerNote).trim(), '');
  lines.push('— KEIBA Analytics', 'https://analytics.keiba.link', '');
  lines.push('配信を停止する:', str(unsubscribeUrl));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** HTML と text を**同時に**作る（片方だけ更新される事故を防ぐ） */
export function renderMarketingEmail(input = {}) {
  return {
    html: renderMarketingHtml(input),
    text: renderMarketingText(input),
  };
}

/**
 * 受信者ごとの無料期間の終了日を差し込む。
 * 文言が空なら**印を含む段落ごと消す**（「までです。」だけが残らないように）。
 */
export function applyGrantExpiry(content, note) {
  const s = str(content);
  if (!s.includes(GRANT_EXPIRY_PLACEHOLDER)) return s;
  const text = str(note).trim();
  if (text) return s.split(GRANT_EXPIRY_PLACEHOLDER).join(escapeHtml(text));
  // HTML: 印を含む段落を落とす / text: 印の行を落とす
  return s
    .replace(new RegExp(`<p[^>]*>[^<]*${GRANT_EXPIRY_PLACEHOLDER.replace(/[{}]/g, '\\$&')}[^<]*</p>\\s*`, 'g'), '')
    .split('\n').filter((l) => !l.includes(GRANT_EXPIRY_PLACEHOLDER)).join('\n');
}

/**
 * 受信者ごとの配信停止 URL を差し込む。
 * **印が 1 つも無ければ null**（送信側はこれを見て止める / fail closed）。
 */
export function applyUnsubscribeUrl(content, url) {
  const s = str(content);
  const u = str(url).trim();
  if (!s.includes(UNSUBSCRIBE_PLACEHOLDER)) return null;
  if (!u) return null;
  return s.split(UNSUBSCRIBE_PLACEHOLDER).join(u);
}

/**
 * 保存済み HTML から text/plain を作る（キュー登録時の HTML しか残っていない経路用）。
 * **自前のマークアップだけ**を対象にした変換で、外部 HTML の一般パーサではない。
 */
export function plainTextFromMarketingHtml(html) {
  return str(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<div style="display:none[\s\S]*?<\/div>/gi, '')   // プリヘッダーは本文に出さない
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `${label.replace(/<[^>]+>/g, '').trim()}: ${href}`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h1|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n').map((l) => l.trim()).filter((l, i, a) => l || (a[i - 1] || '').length)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
