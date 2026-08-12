/**
 * audienceSegments.js — 大規模セグメントの**件数だけ**を出す単一源（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 既存のマーケティング画面は「顧客を 1 人ずつ選ぶ」前提で、選んだ recordId を
 * サーバーへ送っていた。数十名なら成立するが、**AK 登録済みの無料ユーザーだけで約 1,300 名**。
 * さらに**外部保有の無料ユーザーリスト約 13,000 件**を将来取り込むので、
 * 統合後は 14,000 件規模になる。そのまま延ばすと
 *
 *   - 全件をブラウザへ描画して固まる
 *   - 個人情報を大量に画面へ出す
 *   - クライアントが送る recordId 一覧が「対象の正本」になってしまう
 *
 * が同時に起きる。そこで**対象条件をサーバー側に置き、画面へは件数だけ返す**。
 *
 * ── このモジュールが返さないもの ──────────────────────────────
 * メールアドレス / 氏名 / recordId / 内部 ID。返すのは
 * **母数・送信候補・除外数・除外理由別件数・条件ハッシュ**だけ。
 *
 * ── 数え方の約束（ここが崩れると信用できない数字になる）──────────
 *   1. 母数は**一意メールアドレス**で数える（レコード数ではない）
 *   2. 同じアドレスの 2 件目以降は母数にも除外にも入れない（別枠で報告）
 *   3. **母数 = 送信候補 + 除外合計** が常に成り立つ
 *   4. 判定できない材料があれば**送らない側へ倒す**（fail closed）
 *   5. 除外は理由別に必ず数える。黙って落とさない
 */

import { createHash } from 'node:crypto';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { classifyComebackSegment, SEGMENT } from '../entitlements/comebackAudience.js';
import { checkSelectable, CB_SKIP_LABEL } from '../comeback/comebackGrantPlan.js';
import { isRecentMarketingContact } from '../marketing/campaignSend.js';

/** セグメント定義の版。条件の意味を変えたら上げる（ハッシュも変わる） */
export const SEGMENT_CATALOG_VERSION = 1;

/** 除外理由（固定コード）。表示名は下の LABEL が単一源 */
export const SEG_EXCLUDE = Object.freeze({
  DUPLICATE_EMAIL: 'duplicate_email',
  NO_EMAIL: 'no_email',
  INVALID_EMAIL: 'invalid_email',
  SUSPENDED_OR_TEST: 'suspended_or_test',
  FORCE_LOGOUT: 'force_logout',
  UNSUBSCRIBED: 'unsubscribed',
  BLACKLIST_HARD: 'blacklist_hard',
  BLACKLIST_SOFT: 'blacklist_soft',
  PROVIDER_SUPPRESSED: 'provider_suppressed',
  PROVIDER_UNKNOWN: 'provider_unknown',
  PAID_MEMBER: 'paid_member',
  RECENT_CONTACT: 'recent_contact',
  ALREADY_DELIVERED: 'already_delivered',
  ENGAGEMENT_BLOCKED: 'engagement_blocked',
});

export const SEG_EXCLUDE_LABEL = Object.freeze({
  duplicate_email: '同一メールアドレスの重複レコード',
  no_email: 'メールアドレス未登録',
  invalid_email: 'メールアドレス不正',
  suspended_or_test: 'アカウント停止・テストアカウント',
  force_logout: '強制ログアウト',
  unsubscribed: '配信停止',
  blacklist_hard: 'バウンス・苦情リスト（hard）',
  blacklist_soft: 'ソフトバウンス履歴',
  provider_suppressed: '配信基盤の停止リスト',
  provider_unknown: '配信基盤の停止リストを確認できない（送らない側へ倒す）',
  paid_member: '現役の有料会員',
  recent_contact: '直近 24 時間に送信済み',
  already_delivered: 'このキャンペーンで送信済み',
  engagement_blocked: '反応なしが続いている（開封・クリック・購入・ログインなし）',
});

/** 「長期未ログイン」とみなす日数 */
export const DORMANT_DAYS = 180;
/** 「最近ログインした」とみなす日数 */
export const RECENT_LOGIN_DAYS = 90;

const str = (v) => String(v ?? '').trim();
const em = (v) => str(v).toLowerCase();
const DAY = 86400000;

function lastLoginMs(f) {
  const t = Date.parse(str(f['最終ログイン']) || str(f.LastLoginAt) || '');
  return Number.isFinite(t) ? t : null;
}
function everPaid(f) {
  return !!(f.PaidAt || str(f['有効期限']) || str(f.ExpirationDate)
    || f.LifetimeSanrenpuku === true || f.SanrenpukuPaidAt);
}

/**
 * セグメント定義。**条件は関数で書き、名前と説明を必ず添える**。
 * ここに 1 つ足すだけで preview API と画面に出る（コード修正は不要）。
 *
 * `match(ctx)` は「この人がこのセグメントに属するか」だけを判定する。
 * 送れるかどうか（配信停止・バウンス等）は**共通の絶対除外**が別に見る。
 */
export const SEGMENTS = Object.freeze([
  {
    id: 'free-all',
    name: '無料ユーザー',
    description: '有料契約を持たない会員すべて。',
    match: (c) => c.plan === 'free',
  },
  {
    id: 'free-recent-login',
    name: '最近ログインした無料ユーザー',
    description: `無料会員のうち、直近 ${RECENT_LOGIN_DAYS} 日以内にログインした方。`,
    match: (c) => c.plan === 'free' && c.lastLoginMs !== null
      && (c.nowMs - c.lastLoginMs) <= RECENT_LOGIN_DAYS * DAY,
  },
  {
    id: 'free-dormant',
    name: '長期未ログインの無料ユーザー',
    description: `無料会員のうち、${DORMANT_DAYS} 日以上ログインが無い（記録が無い場合を含む）方。`,
    match: (c) => c.plan === 'free'
      && (c.lastLoginMs === null || (c.nowMs - c.lastLoginMs) >= DORMANT_DAYS * DAY),
  },
  {
    id: 'ex-paid-now-free',
    name: '過去有料・現在無料',
    description: '支払い実績があるが、いまは有料契約が無い方。',
    match: (c) => c.plan === 'free' && c.everPaid === true,
  },
  {
    id: 'expired',
    name: '期限切れ',
    description: '元有料会員で有効期限が過ぎた方。',
    match: (c) => c.segment === SEGMENT.EXPIRED,
  },
  {
    id: 'withdrawn',
    name: '退会・課金停止',
    description: '退会手続きで課金を止めた元会員。メール配信停止とは別の状態です。',
    match: (c) => c.segment === SEGMENT.WITHDRAWN,
  },
  {
    id: 'opened-not-logged-in',
    name: '開封済み・未ログイン',
    description: '案内メールを開封したが、その後ログインしていない方。',
    // ⚠️ 開封の記録が無い＝計測できていない可能性がある。materialize 側が
    //    計測状態を見て「判定不能」を返せるよう、ここでは記録の有無だけを見る
    match: (c) => c.openedAtMs !== null
      && (c.lastLoginMs === null || c.lastLoginMs < c.openedAtMs),
    requires: ['openTracking'],
  },
  {
    id: 'logged-in-not-purchased',
    name: 'ログイン済み・未購入',
    description: 'ログインしたことはあるが、支払い実績が無い方。',
    match: (c) => c.lastLoginMs !== null && c.everPaid !== true,
  },
]);

export const SEGMENT_IDS = Object.freeze(SEGMENTS.map((s) => s.id));

/** id → 定義（未知は null。推測で近いものを返さない） */
export function getSegment(id) {
  return SEGMENTS.find((s) => s.id === str(id)) || null;
}

/**
 * 対象条件のハッシュ。**同じ条件なら常に同じ値**になる。
 * 定義の版・id・条件関数の中身・共通除外の一覧から作るので、
 * 条件をこっそり変えると値が変わり、古い snapshot と突き合わせて検知できる。
 */
export function computeConditionHash(segment, options = {}) {
  const s = segment && typeof segment === 'object' ? segment : null;
  if (!s) return '';
  const seed = [
    `catalog:v${SEGMENT_CATALOG_VERSION}`,
    `id:${str(s.id)}`,
    `match:${String(s.match)}`,
    `requires:${(s.requires || []).join(',')}`,
    `excludes:${Object.values(SEG_EXCLUDE).join(',')}`,
    `campaign:${str(options.campaignId)}:v${str(options.campaignVersion)}`,
    `dormantDays:${DORMANT_DAYS}`,
    `recentLoginDays:${RECENT_LOGIN_DAYS}`,
  ].join('|');
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}

/**
 * セグメントの件数を数える（**件数だけ**。個人情報は 1 つも返さない）。
 *
 * @param {{
 *   records: Array<{id?: string, recordId?: string, fields: object}>,
 *   segmentId: string,
 *   nowMs: number,
 *   blacklistHard?: Set<string>,
 *   blacklistSoft?: Set<string>,
 *   providerSuppressed?: Set<string>|null,   null = 確認できなかった → 全員 fail closed
 *   lastContactAtMs?: Map<string, number>,
 *   deliveredEmails?: Set<string>,            このキャンペーンで送信済み
 *   openedAtMs?: Map<string, number>,
 *   campaignId?: string, campaignVersion?: number,
 *   sampleSize?: number,
 * }} input
 */
export function evaluateSegment(input = {}) {
  const {
    records, segmentId, nowMs, blacklistHard, blacklistSoft, providerSuppressed,
    lastContactAtMs, deliveredEmails, openedAtMs, engagementBlockedEmails,
    campaignId, campaignVersion, sampleSize,
  } = input;

  const segment = getSegment(segmentId);
  if (!segment) {
    return { ok: false, error: 'unknown_segment', segmentId: str(segmentId) };
  }
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const rows = Array.isArray(records) ? records : [];
  const hard = blacklistHard instanceof Set ? blacklistHard : new Set();
  const soft = blacklistSoft instanceof Set ? blacklistSoft : new Set();
  const provider = providerSuppressed instanceof Set ? providerSuppressed : null;
  const contact = lastContactAtMs instanceof Map ? lastContactAtMs : new Map();
  const delivered = deliveredEmails instanceof Set ? deliveredEmails : new Set();
  const opened = openedAtMs instanceof Map ? openedAtMs : new Map();
  // 反応なしで除外される人。**Set が渡されない限り 1 人も除外しない**（材料が無ければ素通り）
  const engagementBlocked = engagementBlockedEmails instanceof Set ? engagementBlockedEmails : new Set();
  const wantSample = Number.isInteger(sampleSize) && sampleSize > 0 ? Math.min(sampleSize, 20) : 0;

  // 同じアドレスが 2 件以上あるかを先に把握する（母数を一意にするため）
  const emailCount = new Map();
  for (const r of rows) {
    const e = em((r && r.fields && r.fields.Email) || '');
    if (e) emailCount.set(e, (emailCount.get(e) || 0) + 1);
  }

  const byReason = {};
  const drop = (code) => { byReason[code] = (byReason[code] || 0) + 1; };
  let total = 0;
  let sendable = 0;
  /** 2 件目以降のレコード（母数にも除外にも入れない。別枠で報告する） */
  let ignoredDuplicateRecords = 0;
  let noEmailRecords = 0;
  const seen = new Set();
  const sample = [];

  for (const r of rows) {
    const f = (r && r.fields) || {};
    const e = em(f.Email);
    if (!e) { noEmailRecords += 1; continue; }        // アドレスが無い＝一意母数に入れられない
    if (seen.has(e)) { ignoredDuplicateRecords += 1; continue; }
    seen.add(e);

    const mk = resolveCustomerMarketing({
      fields: f, nowMs: now, blacklistEmails: hard,
      history: { lastSentAtMs: contact.get(e) ?? null },
    });
    const ctx = {
      plan: mk.plan,
      segment: classifyComebackSegment({ fields: f, nowMs: now }),
      lastLoginMs: lastLoginMs(f),
      everPaid: everPaid(f),
      openedAtMs: opened.get(e) ?? null,
      nowMs: now,
    };
    if (!segment.match(ctx)) continue;                // このセグメントの対象外（除外ではない）

    total += 1;

    // ── 共通の絶対除外（順序は固定。最初に当たった理由で 1 回だけ数える）──
    if (emailCount.get(e) > 1) { drop(SEG_EXCLUDE.DUPLICATE_EMAIL); continue; }
    if (mk.suppressionReasons.includes('invalid_email')) { drop(SEG_EXCLUDE.INVALID_EMAIL); continue; }
    const sel = checkSelectable(f, { duplicateEmail: false });
    if (!sel.ok) {
      drop(sel.reason === 'force_logout_blocked' ? SEG_EXCLUDE.FORCE_LOGOUT
        : sel.reason === 'account_suspended' ? SEG_EXCLUDE.SUSPENDED_OR_TEST
          : SEG_EXCLUDE.INVALID_EMAIL);
      continue;
    }
    if (mk.suppressionReasons.includes('unsubscribed')) { drop(SEG_EXCLUDE.UNSUBSCRIBED); continue; }
    if (hard.has(e)) { drop(SEG_EXCLUDE.BLACKLIST_HARD); continue; }
    if (soft.has(e)) { drop(SEG_EXCLUDE.BLACKLIST_SOFT); continue; }
    // 配信基盤の停止リストを確認できないまま送らない（fail closed）
    if (provider === null) { drop(SEG_EXCLUDE.PROVIDER_UNKNOWN); continue; }
    if (provider.has(e)) { drop(SEG_EXCLUDE.PROVIDER_SUPPRESSED); continue; }
    if (mk.premiumActive || mk.lightActive) { drop(SEG_EXCLUDE.PAID_MEMBER); continue; }
    if (delivered.has(e)) { drop(SEG_EXCLUDE.ALREADY_DELIVERED); continue; }
    if (isRecentMarketingContact({ lastSentAtMs: contact.get(e) ?? null, nowMs: now })) {
      drop(SEG_EXCLUDE.RECENT_CONTACT); continue;
    }
    // 反応なしが続いている相手（`engagementGuard.js` が適用可と判断したときだけ渡される）。
    // unsubscribe とは別で、購入・ログイン・開封があれば次回は対象へ戻る。
    if (engagementBlocked.has(e)) { drop(SEG_EXCLUDE.ENGAGEMENT_BLOCKED); continue; }

    sendable += 1;
    // 検証用サンプルは**匿名化した属性だけ**（アドレス・氏名・recordId は入れない）
    if (sample.length < wantSample) {
      sample.push({
        plan: mk.plan,
        contract: mk.contract,
        segment: ctx.segment,
        everPaid: ctx.everPaid,
        hasLoginRecord: ctx.lastLoginMs !== null,
        emailDomainKind: e.endsWith('.jp') ? 'jp' : 'other',
      });
    }
  }

  const excluded = Object.values(byReason).reduce((a, b) => a + b, 0);
  return {
    ok: true,
    segmentId: segment.id,
    segmentName: segment.name,
    description: segment.description,
    catalogVersion: SEGMENT_CATALOG_VERSION,
    conditionHash: computeConditionHash(segment, { campaignId, campaignVersion }),
    total,
    sendable,
    excluded,
    byReason,
    byReasonLabeled: Object.fromEntries(
      Object.entries(byReason)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [SEG_EXCLUDE_LABEL[k] || k, v]),
    ),
    /** 母数 = 送信候補 + 除外合計。崩れていたら数え方が壊れている */
    balanced: total === sendable + excluded,
    /** 母数に入れなかったレコード（一意化の内訳。人ではなく行の数）*/
    ignoredRecords: { duplicateEmail: ignoredDuplicateRecords, noEmail: noEmailRecords },
    /** 判定に外部状態が要るセグメントはここに出す（計測無効なら画面が警告する）*/
    requires: segment.requires || [],
    sample,
    evaluatedAtMs: now,
  };
}

/** すべてのセグメントを一度に数える（画面の一覧用） */
export function evaluateAllSegments(input = {}) {
  return SEGMENT_IDS.map((id) => evaluateSegment({ ...input, segmentId: id }));
}

export default evaluateSegment;
