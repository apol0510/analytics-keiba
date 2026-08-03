/**
 * comebackGrantCampaign.js — 付与した特典 → 案内キャンペーンの対応（純粋・I/O なし）
 *
 * ── 何のために要るか ──────────────────────────────────────────
 * 無料付与の成功者を案内メール工程へ引き継いだあと、管理者は「どの文面を送るか」を
 * 選ばされる。既定は「最初に使えるキャンペーン」で、それが**運用テスト専用カナリア**
 * だった（2026-08-03 本番で確認）。テスト用文面が顧客向けの既定になっているのは危険で、
 * かつ本来の案内文面（すでに配った特典の説明）が候補に無かった。
 *
 * ── 方針: 対応表に無いものは自動選択しない（fail closed）────────────
 * 「Light 30日無料を配った」ことと「Light 30日無料の案内文面」は 1 対 1 で対応する。
 * それ以外の組み合わせ（永久無料・Premium・両方など）は、**文面が用意できるまで
 * 自動選択しない**。近い文面を当てにいくと、
 *
 *   永久無料を配ったのに「30日間無料」と案内する
 *   Light だけ配ったのに Premium の話をする
 *
 * という誤案内になる。テンプレートが無いことは画面で言い、手動選択を求める。
 *
 * ⚠️ このモジュールは**キャンペーン ID を返すだけ**。実際に送ってよい相手かどうかは
 *    従来どおり `campaignSend.js` / `marketingDispatchGate.js` が決める。
 */

/**
 * 付与した特典 → 案内キャンペーン。
 * **1 対 1 で対応が取れるものだけ**を載せる（近いものを当てにいかない）。
 */
export const GRANT_CAMPAIGN_BY_OFFER = Object.freeze({
  'light-30d-free': 'comeback-light-30d-granted',
});

/** 自動選択できない理由（固定コード） */
export const GRANT_CAMPAIGN_BLOCK = Object.freeze({
  NO_GRANT: 'no_grant',
  MULTI_TIER: 'multi_tier',
  TEMPLATE_MISSING: 'template_missing',
});

export const GRANT_CAMPAIGN_BLOCK_LABEL = Object.freeze({
  [GRANT_CAMPAIGN_BLOCK.NO_GRANT]: '付与した特典が分からないため、送る文面を手動で選んでください。',
  [GRANT_CAMPAIGN_BLOCK.MULTI_TIER]: 'Light と Premium を同時に付与したときの案内文面は未設定です。送る文面を手動で選んでください。',
  [GRANT_CAMPAIGN_BLOCK.TEMPLATE_MISSING]: 'この特典に対応する案内文面は未設定です。送る文面を手動で選んでください。',
});

/** 画面に出す共通の注意（対応表に無いときは必ず手動選択させる） */
export const TEMPLATE_MISSING_NOTICE =
  '対応テンプレート未設定です。付与した内容に合う文面を手動で選んでください（違う特典の文面を送らないため、自動では選びません）。';

const str = (v) => String(v ?? '').trim();

/**
 * 引き継ぎ票の付与内容から、初期選択するキャンペーンを決める。
 *
 * @param {{ light?: string|null, premium?: string|null }} grantOffers 付与した特典の offerId
 * @returns {{ campaignId: string|null, reason: string|null, label: string }}
 */
export function recommendCampaignForGrant(grantOffers = {}) {
  const light = str(grantOffers && grantOffers.light);
  const premium = str(grantOffers && grantOffers.premium);
  const no = (reason) => ({
    campaignId: null, reason, label: GRANT_CAMPAIGN_BLOCK_LABEL[reason] || TEMPLATE_MISSING_NOTICE,
  });

  if (!light && !premium) return no(GRANT_CAMPAIGN_BLOCK.NO_GRANT);
  // 両方配ったときの文面はまだ無い。片方の文面を当てにいかない
  if (light && premium) return no(GRANT_CAMPAIGN_BLOCK.MULTI_TIER);

  const offerId = light || premium;
  const campaignId = GRANT_CAMPAIGN_BY_OFFER[offerId];
  if (!campaignId) return no(GRANT_CAMPAIGN_BLOCK.TEMPLATE_MISSING);
  return { campaignId, reason: null, label: '' };
}

/**
 * 画面の初期選択に使うキャンペーン ID。
 *
 * 1. 引き継ぎの付与内容に対応する文面があればそれ
 * 2. 無ければ「使用可能で、かつ**運用テスト専用ではない**」最初のもの
 * 3. それも無ければ空（選ばせない）
 *
 * ⚠️ 運用テスト専用（`testOnly`）は**絶対に既定にしない**。
 *    テスト文面が顧客向けの初期値になっていると、確認を 1 つ飛ばしただけで顧客へ届く。
 *
 * @param {{ campaigns?: Array, handoff?: object|null }} input
 */
export function pickInitialCampaign({ campaigns, handoff } = {}) {
  const list = Array.isArray(campaigns) ? campaigns : [];
  const usable = list.filter((c) => c && c.usable === true && c.testOnly !== true);

  const rec = handoff && handoff.grantOffers
    ? recommendCampaignForGrant(handoff.grantOffers)
    : { campaignId: null, reason: null, label: '' };

  if (rec.campaignId && usable.some((c) => c.campaignId === rec.campaignId)) {
    return { campaignId: rec.campaignId, matchedGrant: true, reason: null, label: '' };
  }
  // 引き継ぎはあるが対応文面が無い → 既定は入れるが「未設定」と伝えて手動選択を促す
  const fallback = usable.length > 0 ? usable[0].campaignId : '';
  return {
    campaignId: fallback,
    matchedGrant: false,
    reason: handoff ? (rec.reason || GRANT_CAMPAIGN_BLOCK.TEMPLATE_MISSING) : null,
    label: handoff ? (rec.label || TEMPLATE_MISSING_NOTICE) : '',
  };
}

/**
 * CTA の表示内容（管理画面の read-only 表示用）。
 *
 * 受信者ごとに変わる専用 URL（割引オファー）は**実 URL を出さない**。
 * 生成前の印（`{{offerUrl}}`）をそのまま画面へ出すと、運用者が「壊れた URL」と誤解し、
 * かつトークン発行前後の境界が曖昧になる。
 *
 * @param {{ ctaLabel?: string, ctaUrl?: string }} campaign
 */
export function describeCta(campaign = {}) {
  const label = str(campaign && campaign.ctaLabel);
  const url = str(campaign && campaign.ctaUrl);
  if (!label && !url) return { label: '', url: '', perRecipient: false, note: 'CTA は設定されていません。' };
  // `{{ }}` が残っている＝送信直前に 1 通ずつ差し替えるキャンペーン
  const perRecipient = /\{\{.*\}\}/.test(url);
  return {
    label,
    url: perRecipient ? '' : url,
    perRecipient,
    note: perRecipient
      ? 'お客様ごとの専用 URL（送信直前に発行されます。ここには表示しません）'
      : '本文に URL は書きません。リンクはこの CTA ボタンだけです。',
  };
}
