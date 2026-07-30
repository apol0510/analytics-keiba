/**
 * campaignCatalog.js — マーケティングキャンペーン定義の単一源（純粋・I/O なし）
 *
 * 件名・本文を Function や管理画面へ散らさない。**追加・編集はこのファイルだけ**で完結させる。
 *
 * ── 各キャンペーンが必ず持つもの ────────────────────────────────────
 *   campaignId / version / name / subject / body / recommendedSegments /
 *   ctaUrl / ctaLabel / enabled / audienceRule
 *
 * ── version の意味（冪等性の鍵）────────────────────────────────────
 *   version を上げると DeliveryKey が変わり、**同じ人へもう一度送れる**ようになる。
 *   逆に言えば version を変えない限り同じ相手には二度と送られない。
 *   本文を直したのに version を据え置くと「直した内容が届かない」ので、
 *   実質的な内容変更をしたら必ず version を上げること。
 *
 * ── audienceRule（誤爆防止）──────────────────────────────────────
 *   「期限切れ会員へのカムバック」を有効会員へ送るような事故を構造的に防ぐ。
 *   enforce=true のキャンペーンは、条件に合わない受信者を dry-run 時点で除外し、
 *   除外理由（segment_mismatch）を件数表示する。汎用キャンペーンは制限しない。
 *
 * ⚠️ 本文に配信停止リンクを書かないこと。送信基盤
 *    （execute-scheduled-emails-background）が全通に配信停止リンクと
 *    List-Unsubscribe ヘッダを自動付与する。二重に出さない。
 * ⚠️ 本番 URL は `https://analytics.keiba.link/` のみ（CLAUDE.md §本番 URL ルール）。
 *    `analytics.keiba.jp` / `*.netlify.app` は使用禁止（guard テストで検査）。
 */

import { MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';

const SITE = 'https://analytics.keiba.link';

/** 差し込み可能なプレースホルダ（これ以外は使わない） */
export const CAMPAIGN_PLACEHOLDERS = Object.freeze(['{{name}}']);

/** 氏名が空のときの呼びかけ（Airtable の氏名は 51/1441 件しか埋まっていない） */
export const NAME_FALLBACK = 'お客様';

/**
 * キャンペーン定義。
 *
 * audienceRule:
 *   contracts … 許可する契約状態（空配列 = 制限なし）
 *   plans     … 許可するプラン区分（空配列 = 制限なし）
 *   enforce   … true なら不一致を dry-run で除外する / false なら警告のみ
 */
export const CAMPAIGNS = Object.freeze([
  {
    campaignId: 'expired-comeback',
    version: 1,
    name: '期限切れ会員 カムバック',
    description: '有効期限が切れた有料会員へ、再開の案内を送る。',
    subject: '【KEIBA Analytics】もう一度、AI予想をご一緒しませんか',
    body: [
      '{{name}} 様',
      '',
      'KEIBA Analytics をご利用いただきありがとうございました。',
      '現在、お客様の有料プランは期限切れとなっております。',
      '',
      'この間もAI予想の精度改善を続けており、',
      '本命・対抗・単穴の選定ロジックと買い目の作り方を大きく見直しました。',
      '',
      '直近の的中実績は、無料で公開しています。',
      'まずは実績だけでもご覧ください。',
    ].join('\n'),
    ctaLabel: '直近の実績を見る',
    ctaUrl: `${SITE}/results-showcase/nankan/`,
    recommendedSegments: ['contract:expired'],
    audienceRule: { contracts: [MK_CONTRACT.EXPIRED], plans: [], enforce: true },
    enabled: true,
  },
  {
    campaignId: 'premium-renewal',
    version: 1,
    name: 'Premium 再契約',
    description: '期限切れ / 期限間近の Premium 会員へ継続を案内する。',
    subject: '【KEIBA Analytics】Premium プランの継続について',
    body: [
      '{{name}} 様',
      '',
      'いつも KEIBA Analytics をご利用いただきありがとうございます。',
      'Premium プランの有効期限についてご案内いたします。',
      '',
      'Premium では中央（JRA）・南関の有料予想を全会場ご覧いただけます。',
      '継続手続きは下記ページよりお願いいたします。',
    ].join('\n'),
    ctaLabel: '継続手続きへ',
    ctaUrl: `${SITE}/pricing/`,
    recommendedSegments: ['contract:expired', 'contract:expiring_soon'],
    audienceRule: {
      contracts: [MK_CONTRACT.EXPIRED, MK_CONTRACT.EXPIRING_SOON],
      plans: [MK_PLAN.PREMIUM, MK_PLAN.PREMIUM_SANRENPUKU],
      enforce: true,
    },
    enabled: true,
  },
  {
    campaignId: 'sanrenpuku-offer',
    version: 1,
    name: 'Premium Sanrenpuku 案内',
    description: '有効な Premium 会員へ三連複（買い切り）を案内する。',
    subject: '【KEIBA Analytics】三連複予想のご案内',
    body: [
      '{{name}} 様',
      '',
      'いつも KEIBA Analytics をご利用いただきありがとうございます。',
      '',
      'Premium 会員の方だけにご案内しております、',
      '三連複予想（買い切り）についてお知らせいたします。',
      '',
      '馬単とは別軸の買い目で、点数を絞って狙う設計です。',
      '一度のお支払いで、以降ずっとご覧いただけます。',
    ].join('\n'),
    ctaLabel: '三連複予想の詳細',
    ctaUrl: `${SITE}/pricing/`,
    recommendedSegments: ['contract:active', 'plan:premium'],
    audienceRule: {
      contracts: [MK_CONTRACT.ACTIVE, MK_CONTRACT.EXPIRING_SOON],
      plans: [MK_PLAN.PREMIUM],
      enforce: true,
    },
    enabled: true,
  },
  {
    campaignId: 'premium-plus-offer',
    version: 1,
    name: 'Premium Plus 案内',
    description: '三連複会員へ Premium Plus（1日1鞍）を案内する。',
    subject: '【KEIBA Analytics】1日1鞍の予想について',
    body: [
      '{{name}} 様',
      '',
      'いつも KEIBA Analytics をご利用いただきありがとうございます。',
      '',
      '全レースを広く狙うのではなく、その日の全開催から「1鞍だけ」を選ぶ、',
      '超精密AIによる予想をご用意しています。',
      '',
      '対象レースを増やす商品ではありません。',
      '1日1鞍に絞り込む設計です。',
    ].join('\n'),
    ctaLabel: '詳細を見る',
    ctaUrl: `${SITE}/premium-plus/`,
    recommendedSegments: ['plan:premium_sanrenpuku'],
    audienceRule: { contracts: [], plans: [MK_PLAN.PREMIUM_SANRENPUKU], enforce: true },
    enabled: true,
  },
  {
    campaignId: 'dormant-reactivation',
    version: 1,
    name: '長期休眠会員向け',
    description: '長く動きの無い会員へ、無料実績ページを入口に再訪を促す。',
    subject: '【KEIBA Analytics】直近の的中実績をお届けします',
    body: [
      '{{name}} 様',
      '',
      'KEIBA Analytics です。ご無沙汰しております。',
      '',
      '毎日、前日の有料メインレース買い目と結果を無料で公開しています。',
      '当たった日も外した日も、そのまま掲載しています。',
      '',
      'お手すきのときにご覧いただければ幸いです。',
    ].join('\n'),
    ctaLabel: '昨日の買い目と結果',
    ctaUrl: `${SITE}/results-showcase/nankan/`,
    recommendedSegments: ['history:never'],
    audienceRule: { contracts: [], plans: [], enforce: false },
    enabled: true,
  },
  {
    campaignId: 'general-announcement',
    version: 1,
    name: '汎用キャンペーン',
    description: 'セグメント制限なしのお知らせ。対象は管理者が明示選択する。',
    subject: '【KEIBA Analytics】お知らせ',
    body: [
      '{{name}} 様',
      '',
      'いつも KEIBA Analytics をご利用いただきありがとうございます。',
      'お知らせがございます。詳しくは下記ページをご覧ください。',
    ].join('\n'),
    ctaLabel: 'サイトを見る',
    ctaUrl: `${SITE}/`,
    recommendedSegments: [],
    audienceRule: { contracts: [], plans: [], enforce: false },
    enabled: true,
  },
]);

/** 有効なキャンペーンの一覧（本文は含めない軽量メタ。管理画面のセレクト用） */
export function listCampaigns({ includeDisabled = false } = {}) {
  return CAMPAIGNS
    .filter((c) => includeDisabled || c.enabled)
    .map((c) => ({
      campaignId: c.campaignId,
      version: c.version,
      name: c.name,
      description: c.description,
      subject: c.subject,
      ctaLabel: c.ctaLabel,
      ctaUrl: c.ctaUrl,
      recommendedSegments: c.recommendedSegments,
      audienceRule: c.audienceRule,
      enabled: c.enabled,
    }));
}

/** campaignId → 定義。未知 / 無効なら null（fail closed）。 */
export function getCampaign(campaignId, { includeDisabled = false } = {}) {
  const id = String(campaignId ?? '').trim();
  if (!id) return null;
  const c = CAMPAIGNS.find((x) => x.campaignId === id);
  if (!c) return null;
  if (!c.enabled && !includeDisabled) return null;
  return c;
}

/**
 * 表示名を安全化する。
 * - 改行・連続空白は 1 つの空白に畳む（雑な入力データの正規化）
 * - 波括弧・山括弧を含む名前は**採用せず**フォールバックへ倒す。
 *   除去して使うと `{{name}}` が「name 様」のような不自然な文面になるため、
 *   疑わしい入力は名前として使わない（fail closed）。
 */
export function sanitizeName(raw) {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!s || s === NAME_FALLBACK) return NAME_FALLBACK;
  if (/[{}<>]/.test(s)) return NAME_FALLBACK;
  return s.slice(0, 40) || NAME_FALLBACK;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * キャンペーン本文を描画する。
 *
 * - 差し込みは {{name}} のみ。未解決のプレースホルダが残ったら null（fail closed）
 * - 本文は HTML エスケープしてから <p> へ組む（顧客名由来の HTML 注入を防ぐ）
 * - 配信停止リンクは付けない（送信基盤が全通に付与する）
 *
 * @param {{ campaign: object, name?: string }} input
 * @returns {{ subject: string, html: string, text: string }|null}
 */
export function renderCampaign({ campaign, name } = {}) {
  const c = campaign;
  if (!c || typeof c.subject !== 'string' || typeof c.body !== 'string') return null;

  const display = sanitizeName(name);
  const text = c.body.replace(/\{\{\s*name\s*\}\}/g, display);
  if (/\{\{|\}\}/.test(text) || /\{\{|\}\}/.test(c.subject)) return null; // 未解決の差し込みは送らない

  const paragraphs = text.split('\n\n').map((block) => {
    const lines = block.split('\n').map((l) => escapeHtml(l)).join('<br />');
    return `<p style="margin:0 0 1em;line-height:1.8;">${lines}</p>`;
  }).join('\n');

  const cta = c.ctaUrl
    ? `<p style="margin:1.6em 0;"><a href="${escapeHtml(c.ctaUrl)}" style="display:inline-block;padding:12px 24px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">${escapeHtml(c.ctaLabel || '詳細を見る')}</a></p>`
    : '';

  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Hiragino Sans\',sans-serif;color:#1f2937;max-width:600px;margin:0 auto;padding:16px;">',
    paragraphs,
    cta,
    '<hr style="border:0;border-top:1px solid #e5e7eb;margin:2em 0 1em;" />',
    '<p style="font-size:12px;color:#6b7280;margin:0;">KEIBA Analytics<br />' + escapeHtml(SITE) + '</p>',
    '</div>',
  ].filter(Boolean).join('\n');

  const plainCta = c.ctaUrl ? `\n\n${c.ctaLabel || '詳細'}: ${c.ctaUrl}` : '';
  return { subject: c.subject, html, text: `${text}${plainCta}\n\n— KEIBA Analytics\n${SITE}` };
}

/**
 * 受信者がキャンペーンの想定対象か判定する。
 * @returns {{ ok: boolean, enforced: boolean, reason: string|null }}
 */
export function matchesCampaignAudience(campaign, marketing) {
  const rule = (campaign && campaign.audienceRule) || { contracts: [], plans: [], enforce: false };
  const enforced = rule.enforce === true;
  if (!marketing) return { ok: false, enforced, reason: 'unknown_customer' };

  const contractOk = !rule.contracts?.length || rule.contracts.includes(marketing.contract);
  const planOk = !rule.plans?.length || rule.plans.includes(marketing.plan);
  if (contractOk && planOk) return { ok: true, enforced, reason: null };
  return { ok: false, enforced, reason: !contractOk ? 'contract_mismatch' : 'plan_mismatch' };
}

export default CAMPAIGNS;
