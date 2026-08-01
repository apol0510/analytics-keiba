/**
 * recommendedActions.js — 「次に何をするか」の判断材料を作る（純粋・自動実行はしない）
 *
 * ── これは提案であって決定ではない ──────────────────────────────
 * ここで返すのは**画面に出す推奨**だけ。送信・付与・取消は一切行わない。
 * 実行するかは管理者が決め、実行時は既存の dry-run → 確認 → 実行の経路を通る。
 *
 * ── 判定を再実装しない ────────────────────────────────────────
 * 契約状態・送信可否・オファー有効性・頻度ガードは **既存の単一源が出した結果を受け取る**。
 * このモジュールは「その結果をどう読むか」だけを持つ。
 *   - 契約 / プラン / 送信可否 … `customerMarketingAudience.resolveCustomerMarketing`
 *   - ログイン可否 / 権限の根拠 … `auth/memberResolution`
 *   - 閲覧権限・無料特典 … `entitlements/resolveEntitlements`
 *   - オファーの有効性 … `promotions/offerCampaignLink.isLiveOffer`
 *   - 24 時間の頻度ガード … `campaignSend.isRecentMarketingContact` / `MARKETING_MIN_INTERVAL_MS`
 *
 * ── 推測しない ──────────────────────────────────────────────
 * 開封・クリックは配信基盤の保持期間が短く、取得できない期間がある。
 * `engagement.available === false` のときは**開封 0 と解釈しない**（その推奨を出さない）。
 */

import { MARKETING_MIN_INTERVAL_MS } from './campaignSend.js';

/** 推奨の種類。画面のグルーピングと、どのキャンペーン/施策へ繋がるかを持つ */
export const REC = Object.freeze({
  BLOCKED_SUPPRESSED: 'blocked_suppressed',
  BLOCKED_FREQUENCY: 'blocked_frequency',
  COMEBACK_MAIL: 'comeback_mail',
  LIGHT_TRIAL: 'light_trial',
  GRANT_ENDING: 'grant_ending',
  OFFER_REMINDER: 'offer_reminder',
  REWRITE_COPY: 'rewrite_copy',
  PERSONAL_FOLLOW: 'personal_follow',
  ACTIVE_PAID_SKIP: 'active_paid_skip',
  PLUS_CANDIDATE: 'plus_candidate',
  NO_ACTION: 'no_action',
});

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * @param {{
 *   marketing: object,          // resolveCustomerMarketing の結果
 *   entitlements: object,       // resolveEntitlements の結果
 *   membership: object,         // resolveMembership の結果
 *   offers: Array<{ offerId: string, status: string, live: boolean, expiresAt: string, offerPrice: number|null }>,
 *   engagement: { available: boolean, opened: number|null, clicked: number|null, lastOpenAt: string|null, lastClickAt: string|null },
 *   daysSinceLogin: number|null,
 *   lastSentAtMs: number|null,
 *   nowMs: number,
 * }} input
 * @returns {{ recommendations: Array<object>, sendableFrom: string|null }}
 */
export function buildRecommendations(input = {}) {
  const {
    marketing = {}, entitlements = {}, membership = {}, offers = [],
    engagement = { available: false }, daysSinceLogin = null,
    lastSentAtMs = null, nowMs,
  } = input;

  const recs = [];
  const add = (type, title, reason, dataUsed, extra = {}) => {
    recs.push({
      type,
      title,
      reason,
      /** 判断に使ったデータ（画面に出す。ここに無い情報で判断しない） */
      dataUsed,
      /** 実行できる最短日時（頻度ガードなどで待つ必要がある場合） */
      earliestAt: extra.earliestAt ?? null,
      /** 推奨するキャンペーン / 施策（無ければ null） */
      campaignId: extra.campaignId ?? null,
      offerId: extra.offerId ?? null,
      /** いま送れるか（送信を伴わない推奨は null） */
      sendable: extra.sendable ?? null,
      severity: extra.severity || 'info',
    });
  };

  // ── 0. 送信できない状態は最優先で出す（他の推奨より先） ──────────────
  const suppression = Array.isArray(marketing.suppressionReasons) ? marketing.suppressionReasons : [];
  if (marketing.sendable === false) {
    add(REC.BLOCKED_SUPPRESSED, 'メール送信禁止',
      `送信対象外です（${suppression.join('・') || '理由不明'}）。この状態では一斉配信・個別配信のどちらも行いません。`,
      ['customerMarketingAudience.sendable', 'suppressionReasons'],
      { sendable: false, severity: 'danger' });
  }

  // 24 時間の頻度ガード（キャンペーン横断）
  const blockedUntil = Number.isFinite(lastSentAtMs) ? lastSentAtMs + MARKETING_MIN_INTERVAL_MS : null;
  const frequencyBlocked = Number.isFinite(blockedUntil) && blockedUntil > nowMs;
  if (frequencyBlocked) {
    add(REC.BLOCKED_FREQUENCY, '24時間の送信間隔を待つ',
      '直近にマーケティングメールを送っています。次に送れる時刻まで待ってください（この制限は下げません）。',
      ['CampaignDeliveries の最終送信日時', 'MARKETING_MIN_INTERVAL_MS=24h'],
      { earliestAt: iso(blockedUntil), sendable: false, severity: 'warn' });
  }

  const canSendNow = marketing.sendable === true && !frequencyBlocked;
  const earliest = frequencyBlocked ? iso(blockedUntil) : iso(nowMs);

  // ── 1. 有効な有料契約 → 通常のカムバック対象外 ───────────────────
  if (marketing.contract === 'active') {
    add(REC.ACTIVE_PAID_SKIP, 'カムバック施策の対象外',
      '有効な有料契約があります。期限切れ向けの案内や無料体験は送らないでください（既存契約の値引き要求・二重契約の原因になります）。',
      ['customerMarketingAudience.contract=active'],
      { sendable: canSendNow, severity: 'info' });
  }

  // ── 2. 有効なオファーがある → 期限前リマインド ──────────────────
  const liveOffers = offers.filter((o) => o.live);
  const redeemed = offers.filter((o) => String(o.status).toLowerCase() === 'redeemed');
  if (liveOffers.length > 0 && redeemed.length === 0) {
    const soonest = liveOffers
      .map((o) => ({ o, ms: Date.parse(o.expiresAt) }))
      .filter((x) => Number.isFinite(x.ms))
      .sort((a, b) => a.ms - b.ms)[0];
    const days = soonest ? Math.ceil((soonest.ms - nowMs) / DAY) : null;
    add(REC.OFFER_REMINDER, '割引オファーの期限前リマインド',
      `発行済みの割引オファーが未申込です${days != null ? `（残り約 ${days} 日）` : ''}。期限が切れると同じ URL では申し込めません。`,
      ['PromotionalOffers.Status=issued', 'ExpiresAt', 'RedeemedAt が空'],
      { campaignId: 'comeback-offer', offerId: soonest ? soonest.o.offerId : null, earliestAt: earliest, sendable: canSendNow, severity: days != null && days <= 7 ? 'warn' : 'info' });
  }

  // ── 3. 期限切れ × ログインの近さで出し分け ──────────────────────
  if (marketing.contract === 'expired' && redeemed.length === 0 && liveOffers.length === 0) {
    if (daysSinceLogin != null && daysSinceLogin <= 30) {
      add(REC.COMEBACK_MAIL, 'カムバック案内の候補',
        `契約は終了していますが、最近（${daysSinceLogin} 日前）ログインしています。関心が残っているため割引案内が届きやすい状態です。`,
        ['contract=expired', '最終ログイン', 'PromotionalOffers に有効オファーなし'],
        { campaignId: 'expired-comeback', earliestAt: earliest, sendable: canSendNow, severity: 'info' });
    } else {
      const label = daysSinceLogin == null ? 'ログイン記録がありません' : `最終ログインから ${daysSinceLogin} 日経過しています`;
      add(REC.LIGHT_TRIAL, 'Light 無料体験の候補',
        `契約が終了し、${label}。メールだけでは戻りにくいため、無料体験で再訪を促す選択肢があります。`,
        ['contract=expired', '最終ログイン', '無料特典なし'],
        { offerId: 'light-30d-free', earliestAt: earliest, sendable: canSendNow, severity: 'info' });
    }
  }

  // ── 4. 無料特典の期間中 → 終了日と案内時期 ──────────────────────
  const promo = entitlements.promo || {};
  for (const [tier, active, lifetime, untilMs] of [
    ['Light', promo.lightActive, promo.lightLifetime, promo.lightUntilMs],
    ['Premium', promo.premiumActive, promo.premiumLifetime, promo.premiumUntilMs],
  ]) {
    if (!active) continue;
    if (lifetime) {
      add(REC.GRANT_ENDING, `${tier} 無料特典（無期限）`,
        `${tier} の無料特典が無期限で有効です。終了日がないため、継続案内のタイミングは施策側で決めてください。`,
        [`${tier}GrantLifetime`], { severity: 'info' });
      continue;
    }
    if (!Number.isFinite(untilMs)) continue;
    const daysLeft = Math.ceil((untilMs - nowMs) / DAY);
    // 終了 7 日前から案内する想定（実行日は管理者が決める）
    const noticeAt = untilMs - 7 * DAY;
    add(REC.GRANT_ENDING, `${tier} 無料特典の終了案内`,
      `${tier} 無料特典は ${new Date(untilMs).toISOString().slice(0, 10)} に終了します（残り ${daysLeft} 日）。終了前に継続の案内を出すか判断してください。`,
      [`${tier}GrantUntil`],
      { earliestAt: iso(Math.max(nowMs, noticeAt)), sendable: canSendNow, severity: daysLeft <= 7 ? 'warn' : 'info' });
  }

  // ── 5. 反応ベース（取得できているときだけ）──────────────────────
  if (engagement && engagement.available === true) {
    const opened = Number(engagement.opened) || 0;
    const clicked = Number(engagement.clicked) || 0;
    if (opened > 0 && clicked === 0) {
      add(REC.REWRITE_COPY, '文面の見直し候補',
        'メールは開封されていますが、本文中のリンクがクリックされていません。件名は届いていて中身が刺さっていない可能性があります。',
        ['配信基盤の開封・クリック履歴（直近のみ）'],
        { earliestAt: earliest, sendable: canSendNow, severity: 'info' });
    }
    if (clicked > 0 && redeemed.length === 0) {
      add(REC.PERSONAL_FOLLOW, '個別フォローの候補',
        'リンクはクリックされていますが申込に至っていません。金額・手続き・不明点で止まっている可能性があります。',
        ['配信基盤のクリック履歴', 'PromotionalOffers に redeemed なし'],
        { earliestAt: earliest, sendable: canSendNow, severity: 'warn' });
    }
  }

  // ── 6. Premium Plus ────────────────────────────────────────
  const plus = String(marketing.premiumPlusEligibility || '').toLowerCase();
  if (plus === 'eligible' || plus === 'review') {
    add(REC.PLUS_CANDIDATE, `Premium Plus: ${plus === 'eligible' ? '販売可' : '保留（要判断）'}`,
      plus === 'eligible'
        ? 'Premium Plus の販売資格があります。案内は段階公開（PHASE）の条件も満たす場合のみ送れます。'
        : 'Premium Plus の判定が保留です。販売可否を確認してください。',
      ['Customers.PremiumPlusEligibility'],
      { campaignId: plus === 'eligible' ? 'premium-plus-offer' : null, earliestAt: earliest, sendable: plus === 'eligible' ? canSendNow : false, severity: 'info' });
  }

  if (recs.length === 0) {
    add(REC.NO_ACTION, '推奨なし',
      '現時点で提案できる施策はありません（条件に該当しません）。',
      ['contract', '最終ログイン', 'PromotionalOffers', '無料特典'], { severity: 'info' });
  }

  return {
    recommendations: recs,
    /** いつから送れるか（送信を伴う施策の共通の下限） */
    sendableFrom: marketing.sendable === false ? null : earliest,
  };
}
