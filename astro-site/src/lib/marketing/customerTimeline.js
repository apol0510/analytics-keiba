/**
 * customerTimeline.js — 1 顧客の出来事を時系列に並べる（純粋・Airtable 非依存）
 *
 * 管理画面の「この人に何が起きたか」を 1 本の時系列にする。
 *
 * ── 推測しない（この設計の芯）────────────────────────────────────
 * **存在する台帳・フィールドの値だけ**を並べる。日時が保存されていない出来事は
 * 「日時不明」として扱い、**近い日時で代用しない**（代用すると施策の効果測定が壊れる）。
 * 各行に必ず `source`（どの台帳の何列から来たか）を持たせ、画面で併記する。
 *
 * ── 取得できないもの（2026-08-01 時点の実測）─────────────────────
 *   - **問い合わせ履歴**: Airtable に問い合わせ台帳が存在しない（Base のテーブル一覧に無い）。
 *     → タイムラインに出さない。「取得不可」として画面に明示する
 *   - **有料契約の開始・終了の履歴**: 契約履歴テーブルが無い。Customers の
 *     `PaidAt` / `有効期限` / `WithdrawalDate` という **現在値のスナップショット**しか無いので、
 *     「過去に何回契約したか」は復元できない（最新 1 件ぶんだけ出す）
 *   - **オファー取消の日時**: `PromotionalOffers` に取消日時の列が無い（`RedeemedAt` のみ）。
 *     → `Status='revoked'` は**日時不明**として出す
 *   - **開封 / クリック**: AK 側に保存していない。配信基盤の Activity API からしか取れず
 *     **保持期間が短い**（実測 3 日）。呼び出し側が取得できたぶんだけ `activityEvents` で渡す。
 *     渡されなければ**その期間の反応は不明**として扱う（0 件と表示しない）
 */

/** 出来事の種別（画面のラベルと絞り込みに使う） */
export const TL_TYPE = Object.freeze({
  REGISTERED: 'registered',
  LOGIN: 'login',
  PAYMENT_CONFIRMED: 'payment_confirmed',
  CONTRACT_EXPIRES: 'contract_expires',
  WITHDRAWAL: 'withdrawal',
  GRANT_GIVEN: 'grant_given',
  GRANT_REVOKED: 'grant_revoked',
  GRANT_ENDS: 'grant_ends',
  OFFER_ISSUED: 'offer_issued',
  OFFER_EXPIRES: 'offer_expires',
  OFFER_REDEEMED: 'offer_redeemed',
  OFFER_REVOKED: 'offer_revoked',
  CAMPAIGN_SENT: 'campaign_sent',
  CAMPAIGN_SKIPPED: 'campaign_skipped',
  MAIL_DELIVERED: 'mail_delivered',
  MAIL_BOUNCED: 'mail_bounced',
  MAIL_OPENED: 'mail_opened',
  MAIL_CLICKED: 'mail_clicked',
  PLUS_ELIGIBILITY: 'plus_eligibility',
});

export const TL_TYPE_LABEL = Object.freeze({
  registered: '会員登録',
  login: 'ログイン',
  payment_confirmed: '入金確認',
  contract_expires: '契約の有効期限',
  withdrawal: '退会申請',
  grant_given: '無料特典 付与',
  grant_revoked: '無料特典 取消',
  grant_ends: '無料特典 終了',
  offer_issued: '割引オファー 発行',
  offer_expires: '割引オファー 期限',
  offer_redeemed: '割引オファー 申込',
  offer_revoked: '割引オファー 取消',
  campaign_sent: 'キャンペーン送信',
  campaign_skipped: 'キャンペーン送信スキップ',
  mail_delivered: 'メール到達',
  mail_bounced: 'メール不達',
  mail_opened: 'メール開封',
  mail_clicked: 'メール内リンク クリック',
  plus_eligibility: 'Premium Plus 判定',
});

/** どの台帳の何から来た情報か（画面に必ず併記する） */
export const TL_SOURCE = Object.freeze({
  CUSTOMERS: 'Customers',
  OFFERS: 'PromotionalOffers',
  DELIVERIES: 'CampaignDeliveries',
  AUTH_TOKENS: 'AuthTokens',
  PROVIDER: '配信基盤の履歴（保持期間が短く、直近のみ）',
});

const str = (v) => String(v ?? '').trim();
const parse = (v) => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : null;
};
const norm = (v) => str(v).toLowerCase();

/**
 * 1 件の出来事。`atMs` が null なら**日時不明**（画面では末尾にまとめる）。
 * @typedef {{ atMs: number|null, at: string|null, type: string, label: string,
 *             detail: string, source: string, field?: string }} TimelineEvent
 */
function ev(atMs, type, detail, source, field) {
  return {
    atMs: Number.isFinite(atMs) ? atMs : null,
    at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
    type,
    label: TL_TYPE_LABEL[type] || type,
    detail: str(detail),
    source,
    field: field || '',
  };
}

/**
 * 顧客 1 名のタイムラインを組み立てる。
 *
 * @param {{
 *   record: { id: string, fields: object, createdTime?: string },
 *   nowMs: number,
 *   offerRecords?: object[],
 *   deliveryRecords?: object[],
 *   tokenRecords?: object[],
 *   activityEvents?: Array<{ atMs: number, kind: 'delivered'|'bounce'|'open'|'click', detail?: string }>,
 *   activityAvailable?: boolean,
 * }} input
 * @returns {{ events: TimelineEvent[], unknownDateEvents: TimelineEvent[], limits: object }}
 */
export function buildCustomerTimeline(input = {}) {
  const {
    record, nowMs, offerRecords = [], deliveryRecords = [], tokenRecords = [],
    activityEvents = null, activityAvailable = false,
  } = input;

  const fields = (record && record.fields) || {};
  const recordId = str(record && record.id);
  const email = norm(fields.Email);
  const out = [];

  // ── Customers（現在値のスナップショット。履歴テーブルは無い）──────────
  const registered = parse(fields['登録日']) ?? parse(record && record.createdTime);
  if (registered != null) out.push(ev(registered, TL_TYPE.REGISTERED, '無料会員として登録', TL_SOURCE.CUSTOMERS, '登録日'));

  const lastLogin = parse(fields['最終ログイン']);
  if (lastLogin != null) out.push(ev(lastLogin, TL_TYPE.LOGIN, 'ログイン記録', TL_SOURCE.CUSTOMERS, '最終ログイン'));

  const paidAt = parse(fields.PaidAt);
  if (paidAt != null) {
    out.push(ev(paidAt, TL_TYPE.PAYMENT_CONFIRMED,
      `入金確認（${str(fields['プラン'])}${str(fields.PlanType) ? ' / ' + str(fields.PlanType) : ''}）`,
      TL_SOURCE.CUSTOMERS, 'PaidAt'));
  }

  const expiry = parse(fields['有効期限'] || fields.ExpirationDate);
  if (expiry != null) {
    const past = expiry <= nowMs;
    out.push(ev(expiry, TL_TYPE.CONTRACT_EXPIRES,
      past ? `契約終了（${str(fields['プラン'])}）` : `契約の有効期限（${str(fields['プラン'])}・未到来）`,
      TL_SOURCE.CUSTOMERS, '有効期限'));
  }

  const withdrawal = parse(fields.WithdrawalDate);
  if (withdrawal != null || fields.WithdrawalRequested === true) {
    out.push(ev(withdrawal, TL_TYPE.WITHDRAWAL,
      str(fields.WithdrawalReason) ? `退会申請（理由: ${str(fields.WithdrawalReason).slice(0, 40)}）` : '退会申請',
      TL_SOURCE.CUSTOMERS, 'WithdrawalDate'));
  }

  // 無料特典（付与 / 取消 / 終了予定）。ティアごとに同じ形の列がある
  for (const [tier, F] of [
    ['Light', { LIFETIME: 'LightGrantLifetime', UNTIL: 'LightGrantUntil', GRANTED_AT: 'LightGrantedAt', GRANTED_BY: 'LightGrantedBy', REVOKED_AT: 'LightGrantRevokedAt', REASON: 'LightGrantRevokeReason' }],
    ['Premium', { LIFETIME: 'PremiumGrantLifetime', UNTIL: 'PremiumGrantUntil', GRANTED_AT: 'PremiumGrantedAt', GRANTED_BY: 'PremiumGrantedBy', REVOKED_AT: 'PremiumGrantRevokedAt', REASON: 'PremiumGrantRevokeReason' }],
  ]) {
    const grantedAt = parse(fields[F.GRANTED_AT]);
    const revokedAt = parse(fields[F.REVOKED_AT]);
    const until = parse(fields[F.UNTIL]);
    const lifetime = fields[F.LIFETIME] === true;
    if (grantedAt != null) {
      const span = lifetime ? '無期限' : (until != null ? `〜${new Date(until).toISOString().slice(0, 10)}` : '期限不明');
      const by = str(fields[F.GRANTED_BY]);
      out.push(ev(grantedAt, TL_TYPE.GRANT_GIVEN,
        `${tier} 無料特典（${span}）${by ? ' / 実行: ' + by : ''}`, TL_SOURCE.CUSTOMERS, F.GRANTED_AT));
    }
    if (revokedAt != null) {
      out.push(ev(revokedAt, TL_TYPE.GRANT_REVOKED,
        `${tier} 無料特典を取消${str(fields[F.REASON]) ? '（' + str(fields[F.REASON]).slice(0, 40) + '）' : ''}`,
        TL_SOURCE.CUSTOMERS, F.REVOKED_AT));
    }
    // 終了予定は「未到来なら予定・到来済みなら終了」として 1 行だけ出す（取消済みなら出さない）
    if (until != null && revokedAt == null && !lifetime) {
      out.push(ev(until, TL_TYPE.GRANT_ENDS,
        until <= nowMs ? `${tier} 無料特典が終了` : `${tier} 無料特典の終了予定`, TL_SOURCE.CUSTOMERS, F.UNTIL));
    }
  }

  // Premium Plus 判定の更新
  const plusUpdated = parse(fields.PremiumPlusEligibilityUpdatedAt);
  if (plusUpdated != null) {
    out.push(ev(plusUpdated, TL_TYPE.PLUS_ELIGIBILITY,
      `判定: ${str(fields.PremiumPlusEligibility) || '未設定'}${str(fields.PremiumPlusEligibilityReason) ? '（' + str(fields.PremiumPlusEligibilityReason).slice(0, 40) + '）' : ''}`,
      TL_SOURCE.CUSTOMERS, 'PremiumPlusEligibilityUpdatedAt'));
  }

  // ── PromotionalOffers ────────────────────────────────────────
  const mine = (offerRecords || []).filter((o) => str(o?.fields?.CustomerRecordId) === recordId
    || (!!email && norm(o?.fields?.Email) === email));
  for (const o of mine) {
    const f = o.fields || {};
    const price = Number(f.OfferPrice) || null;
    const regular = Number(f.RegularPrice) || null;
    const money = price != null ? `¥${(regular || 0).toLocaleString()} → ¥${price.toLocaleString()}` : '';
    const startsAt = parse(f.StartsAt);
    const expiresAt = parse(f.ExpiresAt);
    const redeemedAt = parse(f.RedeemedAt);
    const status = norm(f.Status);

    if (startsAt != null) out.push(ev(startsAt, TL_TYPE.OFFER_ISSUED, `${str(f.OfferId)} ${money}`, TL_SOURCE.OFFERS, 'StartsAt'));
    if (redeemedAt != null) out.push(ev(redeemedAt, TL_TYPE.OFFER_REDEEMED, `${str(f.OfferId)} を申込`, TL_SOURCE.OFFERS, 'RedeemedAt'));
    if (status === 'revoked') {
      // ⚠️ 取消日時の列が無いので **日時不明**。StartsAt 等で代用しない
      out.push(ev(null, TL_TYPE.OFFER_REVOKED, `${str(f.OfferId)} を取消（日時は台帳に無し）`, TL_SOURCE.OFFERS, 'Status'));
    }
    if (expiresAt != null && status !== 'redeemed' && status !== 'revoked') {
      out.push(ev(expiresAt, TL_TYPE.OFFER_EXPIRES,
        expiresAt <= nowMs ? `${str(f.OfferId)} が期限切れ` : `${str(f.OfferId)} の期限`, TL_SOURCE.OFFERS, 'ExpiresAt'));
    }
  }

  // ── CampaignDeliveries ───────────────────────────────────────
  const myDeliveries = (deliveryRecords || []).filter((d) => norm(d?.fields?.RecipientEmail) === email);
  for (const d of myDeliveries) {
    const f = d.fields || {};
    const at = parse(f.SentAt) ?? parse(f.QueuedAt);
    const status = norm(f.Status);
    const type = status === 'sent' ? TL_TYPE.CAMPAIGN_SENT : TL_TYPE.CAMPAIGN_SKIPPED;
    const detail = status === 'sent'
      ? str(f.CampaignType)
      : `${str(f.CampaignType)}（${status}${str(f.Metadata) ? ': ' + str(f.Metadata).slice(0, 40) : ''}）`;
    out.push(ev(at, type, detail, TL_SOURCE.DELIVERIES, f.SentAt ? 'SentAt' : 'QueuedAt'));
  }

  // ── AuthTokens（有料会員のログインリンク使用 = 実ログイン）──────────
  for (const t of (tokenRecords || [])) {
    const f = t.fields || {};
    if (f.Used !== true) continue; // 未使用＝ログインしていない
    if (norm(f.Email) !== email) continue;
    const at = parse(f.UsedAt) ?? parse(f.CreatedAt) ?? parse(t.createdTime);
    if (at == null) continue;
    out.push(ev(at, TL_TYPE.LOGIN, 'ログインリンクを使用', TL_SOURCE.AUTH_TOKENS, f.UsedAt ? 'UsedAt' : 'CreatedAt'));
  }

  // ── 配信基盤の反応（渡されたぶんだけ。保持期間外は「不明」であって 0 ではない）──
  for (const a of (activityEvents || [])) {
    const type = a.kind === 'click' ? TL_TYPE.MAIL_CLICKED
      : a.kind === 'open' ? TL_TYPE.MAIL_OPENED
        : a.kind === 'bounce' ? TL_TYPE.MAIL_BOUNCED
          : TL_TYPE.MAIL_DELIVERED;
    out.push(ev(a.atMs, type, str(a.detail), TL_SOURCE.PROVIDER, ''));
  }

  const dated = out.filter((e) => e.atMs != null).sort((a, b) => b.atMs - a.atMs);
  const undated = out.filter((e) => e.atMs == null);

  return {
    events: dated,
    unknownDateEvents: undated,
    limits: {
      /** 問い合わせ台帳は Base に存在しない（2026-08-01 実測） */
      inquiriesAvailable: false,
      /** 契約履歴テーブルが無いため、過去の契約は最新 1 件ぶんのみ */
      contractHistoryIsSnapshotOnly: true,
      /** オファー取消の日時は台帳に列が無い */
      offerRevokeHasNoTimestamp: mine.some((o) => norm(o?.fields?.Status) === 'revoked'),
      /** 開封・クリックを取得できたか（false なら「反応なし」ではなく「不明」） */
      engagementAvailable: activityAvailable === true,
    },
  };
}

/**
 * タイムラインから反応（開封・クリック）の要約を作る。
 * **取得できていない場合は 0 ではなく null** を返す（「反応なし」と誤読させない）。
 */
export function summarizeEngagement({ events = [], available = false } = {}) {
  if (!available) return { available: false, lastOpenAt: null, lastClickAt: null, opened: null, clicked: null };
  const opens = events.filter((e) => e.type === TL_TYPE.MAIL_OPENED);
  const clicks = events.filter((e) => e.type === TL_TYPE.MAIL_CLICKED);
  return {
    available: true,
    opened: opens.length,
    clicked: clicks.length,
    lastOpenAt: opens[0] ? opens[0].at : null,
    lastClickAt: clicks[0] ? clicks[0].at : null,
  };
}
