/**
 * paidPageGate.js — 有料ページのサーバー側認可（既存の単一源へ委譲する薄い層）
 *
 * ── 何のためにあるか ────────────────────────────────────────────
 * 有料ページの多くは `prerender = true` の静的 HTML で、認可はクライアントの
 * `AccessControl`（localStorage の `user-plan`）に依存している。その構造では
 * **localStorage を書き換えるだけで有料本文を読める**
 * （2026-08-08 の監査で確認。`setTestAuth` 除去後も `user-plan` 直接注入は有効）。
 *
 * 本モジュールはページを SSR 化したうえで、**HTML を組み立てる前に**
 * サーバー側で認可を確定させる入口。認可できなければ有料本文を一切返さない。
 *
 * ── 第二の認証方式を作らない ────────────────────────────────────
 * 判定は既存の 2 つの単一源へ**そのまま委譲**する。
 *
 *   1. 本人特定 … `verifyPlanAccess`（ak_session / HttpOnly 署名 Cookie）
 *   2. 権利判定 … `resolveEntitlements`（Airtable の契約・買い切り・無料特典の正本）
 *
 * 新しいトークン・Cookie・localStorage 鍵は一切導入しない。
 *
 * ── なぜ 2 段なのか（session の plan だけでは足りない）────────────
 * session payload が持つのは `plan` 1 つだけで、**`LifetimeSanrenpuku`（三連複の
 * 買い切り永久権）やカムバック無料特典を表現できない**。
 * 実際、`プラン=Premium` + `LifetimeSanrenpuku=true` の会員が本番に存在する。
 * session の plan だけで三連複ページを判定すると、この会員を締め出してしまう。
 *
 * そこで `premium-plus.astro` と同じ形にする:
 *   入口は広め（有料プランなら通す）→ **権利は Airtable を引いて正本で判定**。
 */

import { verifyPlanAccess, PAGE_ACCESS_REJECT } from './pageAccess.js';
import { lookupCustomerFieldsResult } from '../premiumPlus/purchaseAnchorLookup.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
// ⚠️ このファイルは標準出力への書き出しを持たない（staticGuards が禁止。payload/secret 漏洩防止）。
//    出力してよい形は observability 側が単独で決める。
import { logPaidGateDeny } from '../observability/paidGateLog.js';

/**
 * 入口（door）で通す canonical plan。**ここで権利を判定しない。**
 * 有料契約のいずれかであれば通し、実際の可否は下の entitlement で決める。
 */
export const PAID_DOOR_PLANS = Object.freeze([
  'premium-sanrenpuku',
  'premium-combo',
  'premium',
  'premium-predictions',
  'light',
]);

/**
 * `<AccessControl requiredPlan>` の語 → `resolveEntitlements` のどのフラグを見るか。
 * **表記は既存ページに合わせる**（`standard` は Light プランを指す既存語）。
 */
export const REQUIRED_PLAN_ENTITLEMENT = Object.freeze({
  'Premium Sanrenpuku': 'canViewSanrenpuku',
  premium: 'canViewPremium',
  standard: 'canViewLight',
});

/**
 * 表記ゆれを吸収して entitlement フラグ名を返す。未知は null（fail closed）。
 *
 * ⚠️ 複数の権利のどれかで開くページ（例: 三連複アーカイブ = 馬単 Premium の
 *    アップセル面 かつ 三連複保有者の実績面）は `resolveEntitlementFlags` を使う。
 */
export function resolveEntitlementFlag(requiredPlan) {
  const key = String(requiredPlan ?? '').trim();
  if (Object.prototype.hasOwnProperty.call(REQUIRED_PLAN_ENTITLEMENT, key)) {
    return REQUIRED_PLAN_ENTITLEMENT[key];
  }
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(REQUIRED_PLAN_ENTITLEMENT)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * requiredPlan（1 語 or 複数語の配列）→ entitlement フラグ名の配列。
 *
 * **any-of（どれか 1 つでも true なら通す）**。1 つのページに複数の入り口を
 * 認めたいときに使う。判定式そのものは `resolveEntitlements` のままで、
 * ここは「どのフラグを見るか」を決めるだけ（新しい認可を作らない）。
 *
 * 用途の実例 — `/archive-sanrenpuku*`（三連複の的中実績）:
 *   - 馬単のみの Premium 会員 … 購入前に実績を見せるアップセル面（`canViewPremium`）
 *   - 三連複の保有会員       … 自分が買った商品の実績面（`canViewSanrenpuku`）
 * どちらか一方だけで判定すると、もう一方を締め出す（2026-09-02 の事故と同型）。
 *
 * **1 つでも未知の語が混ざったら null**（＝ fail closed。設定ミスで全開にしない）。
 *
 * @param {string|string[]} requiredPlan
 * @returns {string[]|null}
 */
export function resolveEntitlementFlags(requiredPlan) {
  const list = Array.isArray(requiredPlan) ? requiredPlan : [requiredPlan];
  if (list.length === 0) return null;
  const flags = [];
  for (const p of list) {
    const f = resolveEntitlementFlag(p);
    if (!f) return null;
    if (!flags.includes(f)) flags.push(f);
  }
  return flags;
}

/**
 * 三連複の的中実績アーカイブ（`/archive-sanrenpuku*` 系）の閲覧条件。**単一源**。
 *
 * このページ群は 2 つの読者を同時に持つ:
 *   - 馬単のみの Premium 会員 … 購入前に実績を見せる**アップセル面**（`canViewPremium`）
 *   - 三連複の保有会員       … 自分が買った商品の**実績面**（`canViewSanrenpuku`）
 *
 * 片方だけで判定すると、もう一方を締め出す。実際 2026-09-02 以前は
 * `plan === 'premium'` だけを許可しており、**三連複会員が自分の実績から締め出されていた**。
 * 6 ページすべてがこの定数を使う（ページごとに許可リストを書かない）。
 */
export const SANRENPUKU_ARCHIVE_PLANS = Object.freeze(['premium', 'Premium Sanrenpuku']);

/** 有料本文を CDN / 共有キャッシュへ載せない（別人へ配られるのを防ぐ）。 */
export const PAID_PAGE_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});

/**
 * **一時的な障害**。利用者の操作では解決しないので `/login` へ送らない。
 *
 * ⚠️ 2026-08-08 の障害の教訓: Airtable の一時障害（429 / タイムアウト）で
 *    有効な有料会員が `302 /login` に飛ばされ、「ログインが切れた」と誤認して
 *    再ログインを繰り返した。再ログインしても Airtable は復旧しないので直らず、
 *    負荷が増えて 429 がさらに出る悪循環になった。
 *    → 認証の失敗と障害を**応答レベルで分離**する（503 + Retry-After）。
 *
 * `key_missing` / `env_missing` / `unknown_required_plan` は設定・実装のミスだが、
 * これも**利用者が再ログインしても直らない**ので同じ扱いにする。
 */
export const TRANSIENT_DENY_REASONS = Object.freeze([
  'lookup_unavailable',
  'lookup_failed',
  'key_missing',
  'env_missing',
  'unknown_required_plan',
]);

/** その reason が「一時障害（503）」か。ここに無いものは認証失敗として扱う。 */
export function isTransientDenyReason(reason) {
  return TRANSIENT_DENY_REASONS.includes(String(reason ?? ''));
}

/**
 * 内部 reason → `/login?r=` に載せる**利用者向け**コード（allow-list）。
 *
 * ⚠️ 内部 reason をそのまま URL に出さない。ここに無い reason は既定値へ丸めるので、
 *    新しい内部 reason が増えても URL に未知の文字列が出ることはない
 *    （= Location ヘッダへの注入経路にならない）。
 */
export const LOGIN_REASON_CODE = Object.freeze({
  no_cookie: 'no_session',
  no_session: 'no_session',
  no_subject: 'no_session',
  verify_failed: 'no_session',
  customer_not_found: 'no_session',
  session_expired: 'session_expired',
  plan_not_allowed: 'not_entitled',
  entitlement_denied: 'not_entitled',
});

/** `/login?r=` の既定値（未知 reason はこれに丸める）。 */
export const DEFAULT_LOGIN_REASON_CODE = 'no_session';

/** `/login?r=` に出してよいコードの集合（login.astro の表示側と対になる）。 */
export const PUBLIC_LOGIN_REASON_CODES = Object.freeze(
  [...new Set(Object.values(LOGIN_REASON_CODE))],
);

/** 内部 reason を利用者向けコードへ丸める。 */
export function loginReasonCode(reason) {
  return LOGIN_REASON_CODE[String(reason ?? '')] ?? DEFAULT_LOGIN_REASON_CODE;
}

/** 一時障害ページ（503）。**「ログインしてください」と絶対に言わない。** */
const TRANSIENT_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>一時的にご利用いただけません | KEIBA Analytics</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#e2e8f0;
font-family:'Noto Sans JP',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px}
.card{max-width:480px;width:100%;background:rgba(15,23,42,.8);border:1px solid rgba(59,130,246,.2);
border-radius:16px;padding:40px;text-align:center}
h1{font-size:22px;margin:0 0 16px;color:#f8fafc}
p{font-size:15px;line-height:1.8;color:#94a3b8;margin:0 0 16px}
.ok{color:#34d399;font-weight:700}
.btn{display:inline-block;margin-top:8px;background:linear-gradient(135deg,#0ea5e9,#2563eb);
color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:8px}
.sub{font-size:13px;margin-top:24px}
.sub a{color:#60a5fa}
</style></head><body><div class="card">
<h1>一時的にご利用いただけません</h1>
<p>サーバー側の一時的な問題により、会員ページを表示できませんでした。</p>
<p class="ok">ログイン状態は保持されています。<br>ログインし直す必要はありません。</p>
<p>数十秒ほどおいてから、下のボタンで再読み込みしてください。</p>
<a class="btn" href="">再読み込みする</a>
<p class="sub">繰り返し表示される場合は <a href="/contact/">お問い合わせ</a> ください。<br>
<a href="/dashboard/">マイページへ戻る</a></p>
</div></body></html>`;

/** 一時障害 → 503。検索エンジンにも「壊れた」ではなく「今は無理」と伝える。 */
function transientResponse() {
  return new Response(TRANSIENT_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': '30',
      ...PAID_PAGE_HEADERS,
    },
  });
}

/** 認証失敗 → 404（存在秘匿ページ）または `/login?r=<非機微コード>` へ 302。 */
function denyResponse(notFound, reason) {
  if (notFound) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...PAID_PAGE_HEADERS },
    });
  }
  const location = `/login/?r=${loginReasonCode(reason)}`;
  return new Response(null, { status: 302, headers: { Location: location, ...PAID_PAGE_HEADERS } });
}

/**
 * ページ frontmatter から呼ぶ。認可できなければ `response` に Response が入るので、
 * 呼び出し側は `if (gate.response) return gate.response;` と書くだけでよい。
 *
 * @param {{
 *   request: Request,
 *   requiredPlan: string|string[],
 *   env: object,                 **必須**。この層は process.env を直接参照しない
 *                                （ランタイム非依存にするため。呼び出し側が注入する）
 *   now?: number,
 *   notFound?: boolean,          **認証失敗**を 404 にする（既定は /login へ 302）。
 *                                一時障害（TRANSIENT_DENY_REASONS）は notFound に関わらず
 *                                常に 503。この分岐へ来るのは有効な署名 Cookie を持つ
 *                                利用者だけなので、503 でページの存在は漏れない。
 *   lookup?: Function,           テスト用の差し替え（既定 lookupCustomerFields）
 * }} input
 * @returns {Promise<{ ok: boolean, response: Response|null, reason: string, entitlements: object|null }>}
 */
/**
 * lookup の戻り値を正規化する。
 *
 * 新契約: `{ ok:true, fields }` / `{ ok:false, reason:'not_found'|'unavailable' }`
 * 旧契約: `fields | null`（差し替えテストや既存呼び出しの互換）
 *
 * ⚠️ 旧契約の `null` は**区別できない**ので `not_found` として扱う。
 *    認可経路は必ず新契約（`lookupCustomerFieldsResult`）を使うこと。
 */
export function normalizeLookupResult(v) {
  if (!v) return { ok: false, reason: 'not_found' };
  if (v.ok === true && v.fields && typeof v.fields === 'object') return { ok: true, fields: v.fields };
  if (v.ok === false && typeof v.reason === 'string') return { ok: false, reason: v.reason };
  if (typeof v === 'object') return { ok: true, fields: v };   // 旧契約
  return { ok: false, reason: 'not_found' };
}

export async function gatePaidPage({
  request,
  requiredPlan,
  env,
  now = Date.now(),
  notFound = false,
  lookup = lookupCustomerFieldsResult,
} = {}) {
  // any-of。単一語のときも配列 1 要素として扱う（分岐を増やさない）。
  const flags = resolveEntitlementFlags(requiredPlan);
  const deny = (reason) => {
    logPaidGateDeny(reason, requiredPlan);
    // 一時障害は「認証failed」ではない。/login へ送らず 503 で返す（再ログインを促さない）。
    const response = isTransientDenyReason(reason)
      ? transientResponse()
      : denyResponse(notFound, reason);
    return { ok: false, reason, response, entitlements: null };
  };

  // 設定ミスで全開にしない
  if (!flags) return deny('unknown_required_plan');
  // env 未注入は fail closed（既定値で process.env を掴まない）
  if (!env || typeof env !== 'object') return deny('env_missing');

  // ── 1. 本人特定（session。plan は入口の判定にだけ使う）──
  const access = await verifyPlanAccess({
    cookieHeader: request?.headers?.get?.('cookie') || '',
    secret: env.SESSION_SIGNING_SECRET,
    now,
    allowedPlans: PAID_DOOR_PLANS,
  });
  if (!access.ok) {
    // 「期限切れ」だけは利用者に伝えられる（再ログインで直る）。それ以外の検証失敗は
    // 内訳を出さない（署名不正・改竄の詳細を攻撃者に返さない）。
    const expired = access.reason === PAGE_ACCESS_REJECT.VERIFY_FAILED
      && (access.verifyReason === 'expired' || access.verifyReason === 'absolute_expired');
    return deny(expired ? 'session_expired' : (access.reason || 'no_session'));
  }

  const sub = access.payload?.sub || null;
  if (!sub) return deny('no_subject');

  // ── 2. 権利判定（Airtable の正本。買い切り・無料特典もここで効く）──
  // ⚠️ **一時障害と「会員が存在しない」を区別する。**
  //    どちらも通さない（fail closed）が、理由コードを分けないと障害が観測できない。
  //    2026-08-08 の障害では、Airtable の一時障害が customer_not_found に潰れており、
  //    さらに失敗が 10 分キャッシュされて有効会員が締め出されていた。
  let looked = null;
  try {
    looked = await lookup({ recordId: sub, env, now });
  } catch {
    return deny('lookup_failed');
  }
  const r = normalizeLookupResult(looked);
  if (!r.ok) return deny(r.reason === 'not_found' ? 'customer_not_found' : 'lookup_unavailable');
  const fields = r.fields;

  const ent = resolveEntitlements(fromAirtableFields(fields), now);
  // any-of: 指定された権利のどれか 1 つでも true なら通す。0 個は上で弾いている。
  if (!flags.some((f) => ent[f] === true)) return deny('entitlement_denied');

  return { ok: true, response: null, reason: 'ok', entitlements: ent };
}
