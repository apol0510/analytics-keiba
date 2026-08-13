/**
 * premiumPlusFunnelServer.js — 実閲覧の Redis 接続と**サーバー側記録**（SSR / Functions 共用）
 *
 * ## ここにある理由
 *
 * 記録の入口は 3 つある:
 *   - `/api/pp-funnel.json`（CTA 表示・クリック。ブラウザから POST）
 *   - `premium-plus.astro` / `premium-plus-v2.astro`（商品ページ到達。SSR で直接記録）
 *   - `premium-plus-eligibility`（管理画面が**読む**）
 *
 * Redis 接続を 3 か所に書き写すと、env 名や JSON の扱いがすぐズレる。**接続はここだけ**。
 *
 * ## 商品ページ到達をサーバーで数える理由
 *
 * クライアント JS に任せると、JS 無効・広告ブロック・離脱で落ちる。
 * 商品ページは SSR で認可済み（recordId が確定している）ので、そこで数えるのが最も正確。
 *
 * ## ページ描画を絶対に遅らせない
 *
 * Redis が遅い / 落ちているときに商品ページが待たされてはいけない。
 * `RECORD_TIMEOUT_MS` で打ち切り、**記録できなくてもページは通常どおり返す**
 * （その人は「未確認」のままになる。0 回とは記録しない）。
 */

import { createFunnelStore, FUNNEL_EVENT } from './premiumPlusFunnelStore.js';

/** これを超えたら記録を諦めてページを返す（計測のために顧客を待たせない） */
export const RECORD_TIMEOUT_MS = 700;

/** 管理者プレビューであることを明示するヘッダ */
export const ADMIN_PREVIEW_HEADER = 'x-admin-preview';

/**
 * 管理者プレビューか。**明示された印だけ**を見る。
 *
 * ⚠️ ここが本件で最も間違えやすい所。「管理者っぽさ」で除外してはいけない:
 *   - recordId が運営者本人（例: 0510apolone）だから除外 → **誤り**。
 *     運営者が自分の会員アカウントで顧客画面を見たら、それは通常の閲覧であり計上する。
 *   - 管理画面から遷移した（Referer が /admin）から除外 → **誤り**。
 *     管理画面のリンクを踏んで顧客として見ることはある。
 *   - 管理シークレットのヘッダが付いているから除外 → **誤り**。
 *     顧客ページの計測 API は管理シークレットを使わない。
 *
 * 除外されるのは `action='preview'`（管理画面のスナップショット取得）の系統だけで、
 * それは**そもそもこの API を通らない**。ここは二重の歯止めとして印だけを見る。
 */
export function isAdminPreviewRequest({ body, header } = {}) {
  const flag = body && typeof body === 'object' ? body.preview : undefined;
  if (flag === true || String(flag ?? '') === '1') return true;
  return String(header ?? '') === '1';
}

/**
 * Upstash REST の呼び出し関数を作る。**未設定なら null**
 * （呼び出し側は「計測できない」として扱う。0 回と記録しない）。
 */
export function makeRedisCmd(env, { fetchImpl } = {}) {
  const e = env || {};
  if (!e.UPSTASH_REDIS_REST_URL || !e.UPSTASH_REDIS_REST_TOKEN) return null;
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  return async (args) => {
    const res = await doFetch(e.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${e.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`redis_${res.status}`);
    const data = await res.json();
    return data && Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : null;
  };
}

/** 指定時間で諦める（失敗ではなく「間に合わなかった」を返す） */
async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, counted: false, reason: 'timeout' }), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 商品ページ到達を記録する。**例外を投げない**（ページ描画を壊さない）。
 *
 * @param {{
 *   recordId: string|null|undefined,
 *   env: object,
 *   userAgent?: string,
 *   nowMs?: number,
 *   adminPreview?: boolean,
 *   timeoutMs?: number,
 *   redisCmd?: Function|null,   テスト用の差し替え
 * }} input
 * @returns {Promise<{counted:boolean, reason:string|null}>}
 */
export async function recordPlusPageView({
  recordId, env, userAgent, nowMs, adminPreview, timeoutMs, redisCmd,
} = {}) {
  const cmd = redisCmd !== undefined ? redisCmd : makeRedisCmd(env);
  // 計測できないことを黙って 0 回にしない
  if (!cmd) return { counted: false, reason: 'measurement_unavailable' };

  try {
    const store = createFunnelStore({ redisCmd: cmd });
    const out = await withTimeout(store.record({
      recordId,
      event: FUNNEL_EVENT.PAGE_VIEW,
      nowMs: typeof nowMs === 'number' ? nowMs : Date.now(),
      userAgent: userAgent || '',
      // ここへ来ている時点で SSR 認可を通っている
      authenticated: true,
      adminPreview: adminPreview === true,
    }), typeof timeoutMs === 'number' ? timeoutMs : RECORD_TIMEOUT_MS);
    return { counted: out.counted === true, reason: out.reason || null };
  } catch {
    return { counted: false, reason: 'record_failed' };
  }
}

export { FUNNEL_EVENT };
