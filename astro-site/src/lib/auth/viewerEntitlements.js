/**
 * viewerEntitlements.js — 「いま画面を見ているのは誰で、何を見られるか」の単一源（サーバー側）
 *
 * ── なぜ要るか（2026-09-02 の Light 会員問い合わせ）────────────────
 * マイページ（`/dashboard/`）は **localStorage が 1 つでもあるか**だけで
 * 「ログイン済み」を判定し、予想カードは **localStorage のプラン文字列**で出していた。
 *
 *   isAuthenticated() = user-plan || isLoggedIn || userPlan || user_plan || user_email
 *
 * 有料会員の権威は `ak_session`（HttpOnly 署名 Cookie・idle 30 日）とサーバーの
 * Airtable なのに、画面はそれを一切見ていない。結果として **localStorage が消えた会員
 * （別ブラウザ・履歴消去・プライベートウィンドウ）は、セッションが有効でも
 * ログインフォームが出て、予想ページへのリンクが 1 本も無くなる**。
 * さらにグローバルナビには有料予想への直リンクが 1 本も無いため、
 * その会員は**サイト内から予想へ到達する手段を完全に失う**。
 *
 * ── 何をするか ──────────────────────────────────────────────
 * `gatePaidPage` と**同じ 2 つの単一源**へ委譲して、拒否ではなく**状態**を返す。
 *
 *   1. 本人特定 … `verifyPlanAccess`（ak_session）
 *   2. 権利判定 … `resolveEntitlements`（Airtable の契約・買い切り・無料特典）
 *
 * `gatePaidPage` は「通す / 拒む」を決める門なので、拒むときは必ず Response を返す。
 * マイページや導線ルータは**拒まずに分岐したい**（無料会員も正しく扱う）ため、
 * 判定だけを取り出せる入口をここに用意する。**新しい認証方式は作らない。**
 *
 * ── 3 状態にする理由（fail closed のまま「ログアウト」と言わない）──
 * `anonymous` と `unknown` を分ける。Airtable の一時障害や鍵未設定を
 * 「ログアウト」と表示すると、有効な会員に**不要な再ログインを促す**ことになる
 * （2026-08-08 の障害で実際に起きた形）。`unknown` はどちらの権利も与えないが、
 * 画面には「確認できませんでした」と出せる。
 *
 * ⚠️ ここは**権利を与える側**ではない。返した entitlements をそのまま信じてよいのは
 *    サーバーの描画だけで、クライアントへ渡した値は表示の都合にしか使わないこと。
 *    有料本文そのものの保護は従来どおり `gatePaidPage` が行う。
 */

import { verifyPlanAccess, PAGE_ACCESS_REJECT, ALL_MEMBER_PLANS } from './pageAccess.js';
import { normalizeLookupResult } from './paidPageGate.js';
import { lookupCustomerFieldsResult } from '../premiumPlus/purchaseAnchorLookup.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';

/** 閲覧者の状態。**3 値**（`unknown` を `anonymous` に潰さない）。 */
export const VIEWER_STATE = Object.freeze({
  /** ak_session で本人を特定し、Airtable の権利まで確定した */
  MEMBER: 'member',
  /** ログインしていないと**確定できた**（Cookie 無し・期限切れ・署名不正など） */
  ANONYMOUS: 'anonymous',
  /** 判定できなかった（鍵未設定・Airtable 一時障害）。権利は与えないが「ログアウト」でもない */
  UNKNOWN: 'unknown',
});

/**
 * 判定不能（＝ `unknown`）として扱う理由。
 * **利用者の状態ではなく、こちら側の都合**で決められなかったもの。
 */
export const UNKNOWN_REASONS = Object.freeze([
  'env_missing',
  'key_missing',
  'lookup_failed',
  'lookup_unavailable',
]);

/** 権利ゼロ（`anonymous` / `unknown` で返す固定値）。 */
const NO_ENTITLEMENTS = Object.freeze({
  canLogin: false,
  canViewFree: false,
  canViewLight: false,
  canViewPremium: false,
  canViewSanrenpuku: false,
});

function result(state, reason, entitlements = null, recordId = null, profile = null) {
  return Object.freeze({
    state,
    reason,
    recordId,
    entitlements: entitlements || NO_ENTITLEMENTS,
    profile,
    isMember: state === VIEWER_STATE.MEMBER,
  });
}

/**
 * Airtable レコードから**画面に出す分だけ**を取り出す。
 *
 * ⚠️ レコード全体を画面へ渡さない。Customers には配信・請求・運用の列が多数あり、
 *    そのまま HTML に載せると会員本人にも見せる必要のない内部状態まで露出する。
 *    ここに**明示的に列挙した項目だけ**を渡す（列が増えても自動では漏れない）。
 *
 * 列名は `fromAirtableFields` と同じく**表記ゆれを吸収**する（日本語列 / 英語列）。
 */
export function viewerProfile(fields) {
  const f = fields || {};
  const read = (keys) => {
    for (const k of keys) {
      const v = f[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };
  const points = read(['ポイント', 'Points']);
  return {
    email: read(['Email', 'メールアドレス']),
    name: read(['氏名', 'Name', 'お名前']),
    plan: read(['プラン', 'Plan']),
    planType: read(['PlanType']),
    validUntil: read(['有効期限', 'ValidUntil', 'ExpiryDate', 'ExpirationDate']),
    // ⚠️ `Number(null)` は 0（有限）になる。列が無いときに 0pt と表示しないよう、
    //    値が有ることを先に確かめる。
    points: points === null || !Number.isFinite(Number(points)) ? null : Number(points),
  };
}

/**
 * Cookie ヘッダから閲覧者を確定する。**例外を投げない**（呼び出し側の描画を壊さない）。
 *
 * @param {{
 *   request: Request,
 *   env: object,                 **必須**。この層は process.env を直接参照しない
 *   now?: number,
 *   lookup?: Function            テスト用の差し替え口（既定は Airtable 参照）
 * }} input
 * @returns {Promise<{state:string, reason:string, recordId:string|null, entitlements:object, isMember:boolean}>}
 */
export async function resolveViewer({ request, env, now = Date.now(), lookup = lookupCustomerFieldsResult } = {}) {
  // env 未注入は「判定できなかった」。既定値で process.env を掴まない。
  if (!env || typeof env !== 'object') return result(VIEWER_STATE.UNKNOWN, 'env_missing');

  // ── 1. 本人特定 ──
  // 入口は **ログインしている会員全員**。無料・Light を締め出さない
  // （PREMIUM_PLUS_CANDIDATE_PLANS を使うと無料会員が anonymous に化ける）。
  let access;
  try {
    access = await verifyPlanAccess({
      cookieHeader: request?.headers?.get?.('cookie') || '',
      secret: env.SESSION_SIGNING_SECRET,
      now,
      allowedPlans: ALL_MEMBER_PLANS,
    });
  } catch {
    return result(VIEWER_STATE.UNKNOWN, 'verify_threw');
  }

  if (!access.ok) {
    // 鍵が無いのは**利用者がログアウトしている証拠にならない**
    if (access.reason === PAGE_ACCESS_REJECT.KEY_MISSING) {
      return result(VIEWER_STATE.UNKNOWN, 'key_missing');
    }
    if (access.reason === PAGE_ACCESS_REJECT.VERIFY_FAILED) {
      const expired = access.verifyReason === 'expired' || access.verifyReason === 'absolute_expired';
      return result(VIEWER_STATE.ANONYMOUS, expired ? 'session_expired' : 'verify_failed');
    }
    // NO_COOKIE / PLAN_NOT_ALLOWED（未知のプラン名）はログインしていない扱い
    return result(VIEWER_STATE.ANONYMOUS, access.reason || 'no_session');
  }

  const sub = access.payload?.sub || null;
  if (!sub) return result(VIEWER_STATE.ANONYMOUS, 'no_subject');

  // ── 2. 権利判定（Airtable が正本。買い切り・無料特典もここで効く）──
  let looked = null;
  try {
    looked = await lookup({ recordId: sub, env, now });
  } catch {
    return result(VIEWER_STATE.UNKNOWN, 'lookup_failed');
  }
  const r = normalizeLookupResult(looked);
  if (!r.ok) {
    // 「会員が存在しない」と「一時障害」を潰さない（障害が観測できなくなる）
    return r.reason === 'not_found'
      ? result(VIEWER_STATE.ANONYMOUS, 'customer_not_found')
      : result(VIEWER_STATE.UNKNOWN, 'lookup_unavailable');
  }

  let ent;
  try {
    ent = resolveEntitlements(fromAirtableFields(r.fields), now);
  } catch {
    return result(VIEWER_STATE.UNKNOWN, 'entitlements_failed');
  }
  return result(VIEWER_STATE.MEMBER, 'ok', ent, sub, viewerProfile(r.fields));
}

/** `unknown` 扱いにすべき理由か（画面側で「ログアウト」と書かないための判定）。 */
export function isUnknownReason(reason) {
  return UNKNOWN_REASONS.includes(String(reason ?? ''));
}
