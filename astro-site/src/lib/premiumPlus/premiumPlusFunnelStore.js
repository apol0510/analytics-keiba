/**
 * premiumPlusFunnelStore.js — Premium Plus の**実閲覧**を記録する（純粋・I/O は注入）
 *
 * ## なぜ必要か
 *
 * 管理画面の「実表示 Plus CTA」は **`resolveUpsellForCustomer` の判定結果**であって、
 * その人が実際に画面を見た記録ではない。判定と実閲覧を同じ列に出すと
 * 「見えているはず」を「見た」と読み違える。**別の列に分ける**ためにここで実測を持つ。
 *
 * ## 個人情報を増やさない
 *
 * キーは **ログイン会員の recordId**（`ak_session` の `sub`）。
 * これはサーバーが既に持っている識別子で、**アドレスも氏名も保存しない**。
 * クライアントから渡された id は**信用しない**（呼び出し側がセッションから解決する）。
 *
 * ## 何を数えるか
 *
 * | フィールド | 意味 |
 * |---|---|
 * | `cta_first_at` / `cta_last_at` / `cta_views` | CTA の初回・最終表示と回数 |
 * | `click_first_at` / `click_last_at` / `clicks`  | CTA クリック |
 * | `page_first_at` / `page_last_at` / `page_views`| 商品ページ到達 |
 *
 * ## 過剰計上を防ぐ
 *
 * 画面の再描画・タブ復帰・戻る操作で CTA は何度も表示される。
 * **同じ種別は `DEDUPE_MS` の間 1 回しか数えない**（サーバー側で前回時刻と比較する）。
 * クライアントに重複排除を任せない（信用できないため）。
 *
 * ## 読めないときは「0 回」と言わない
 *
 * Redis が未設定・障害のときは `available:false` を返す。呼び出し側は
 * **「未確認」**として表示すること。**0 回と断定してはいけない**
 * （計測を始める前の閲覧も同じく「未確認」）。
 */

/** 版を上げると別の名前空間になる（過去の集計と混ざらない） */
export const FUNNEL_SCHEMA = 1;

/** AK 専用の名前空間 */
export const FUNNEL_NAMESPACE = `ak:pp:funnel:v${FUNNEL_SCHEMA}`;

export const FUNNEL_KEY = Object.freeze({
  /** recordId ごとの集計（HASH のフィールド名に recordId を使う） */
  CTA: `${FUNNEL_NAMESPACE}:cta`,
  CLICK: `${FUNNEL_NAMESPACE}:click`,
  PAGE: `${FUNNEL_NAMESPACE}:page`,
  META: `${FUNNEL_NAMESPACE}:meta`,
});

/** 記録する行動 */
export const FUNNEL_EVENT = Object.freeze({
  CTA_VIEW: 'cta_view',
  CTA_CLICK: 'cta_click',
  PAGE_VIEW: 'page_view',
});

const KEY_OF = Object.freeze({
  [FUNNEL_EVENT.CTA_VIEW]: FUNNEL_KEY.CTA,
  [FUNNEL_EVENT.CTA_CLICK]: FUNNEL_KEY.CLICK,
  [FUNNEL_EVENT.PAGE_VIEW]: FUNNEL_KEY.PAGE,
});

/**
 * 同じ種別を再度数えるまでの最短間隔。
 * 再描画・タブ復帰・戻る操作での過剰計上を潰す。
 */
export const DEDUPE_MS = 30 * 60 * 1000;

/** 記録を始めた時刻（これより前の閲覧は観測できていない） */
export const META_FIELD = Object.freeze({
  SCHEMA: 'schema',
  STARTED_AT: 'started_at',
});

/** Airtable の recordId 形式。これ以外は受け付けない（任意文字列を鍵にしない） */
export const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

export class FunnelStoreError extends Error {
  constructor(reason) {
    super(`pp_funnel:${reason}`);
    this.name = 'FunnelStoreError';
    this.reason = reason;
  }
}

/**
 * 数値へ。**未記録（null / undefined / 空）は null のまま**返す。
 * ⚠️ `Number(null)` は 0 になる。ここで潰すと「未確認」が「0 回」に化ける。
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 1 レコードぶんの生データ → 表示用（**数えられていないものは null**） */
export function shapeFunnelRow(raw) {
  const r = raw || {};
  const pick = (a, b, c) => ({
    firstAtMs: num(r[a]),
    lastAtMs: num(r[b]),
    count: num(r[c]),
  });
  return {
    cta: pick('cta_first_at', 'cta_last_at', 'cta_views'),
    click: pick('click_first_at', 'click_last_at', 'clicks'),
    page: pick('page_first_at', 'page_last_at', 'page_views'),
  };
}

/** 記録が 1 つでもあるか（無いなら「未確認」であって 0 ではない） */
export function hasAnyFunnelRecord(row) {
  const r = row || {};
  return [r.cta, r.click, r.page].some((x) => x && Number.isFinite(x.count) && x.count > 0);
}

/**
 * 記録してよいか（**除外条件はここが単一源**）。
 *
 * @param {{recordId?: string, event?: string, userAgent?: string,
 *          authenticated?: boolean, adminPreview?: boolean}} input
 */
export function shouldRecordFunnelEvent({
  recordId, event, userAgent, authenticated, adminPreview,
} = {}) {
  // 未認証は数えない（存在秘匿の外側からは呼べないが、二重に止める）
  if (authenticated !== true) return { ok: false, reason: 'unauthenticated' };
  // 管理者プレビューは顧客の行動ではない
  if (adminPreview === true) return { ok: false, reason: 'admin_preview' };
  if (!KEY_OF[event]) return { ok: false, reason: 'unknown_event' };
  if (!RECORD_ID_RE.test(String(recordId || ''))) return { ok: false, reason: 'bad_record_id' };
  if (isLikelyBot(userAgent)) return { ok: false, reason: 'bot' };
  return { ok: true, reason: null };
}

/** bot / プリフェッチ判定（保守的に。人間を落とすより bot を通すほうがまし…ではないので明示列挙） */
export function isLikelyBot(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return true;                       // UA が無い = 人間のブラウザではない
  return /bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|headless|phantom|puppeteer|playwright|curl\/|wget|python-requests|monitor|uptime|pingdom|lighthouse|preview/.test(ua);
}

/**
 * Redis を使った集計。**I/O は `redisCmd` 注入のみ**（テストで実 Redis を使わない）。
 */
export function createFunnelStore({ redisCmd } = {}) {
  if (typeof redisCmd !== 'function') throw new FunnelStoreError('redis_not_configured');

  /** HGET 相当（1 レコードぶん） */
  async function readOne(key, recordId) {
    const v = await redisCmd(['HGET', key, recordId]);
    if (v === null || v === undefined) return null;
    try { return JSON.parse(typeof v === 'string' ? v : String(v)); } catch { return null; }
  }

  return {
    /**
     * 1 件記録する。**過剰計上は DEDUPE_MS でサーバー側が潰す**。
     * 失敗しても例外は投げない（計測で画面を壊さない）。
     *
     * @returns {Promise<{ok:boolean, counted:boolean, reason?:string}>}
     */
    async record({ recordId, event, nowMs, userAgent, authenticated, adminPreview } = {}) {
      const gate = shouldRecordFunnelEvent({ recordId, event, userAgent, authenticated, adminPreview });
      if (!gate.ok) return { ok: true, counted: false, reason: gate.reason };

      const now = num(nowMs) ?? 0;
      const key = KEY_OF[event];
      try {
        const cur = (await readOne(key, recordId)) || {};
        const lastAt = num(cur.lastAt);
        // 同じ種別は一定時間 1 回だけ（再描画・戻る操作で増やさない）
        if (lastAt !== null && now - lastAt < DEDUPE_MS) {
          return { ok: true, counted: false, reason: 'deduped' };
        }
        const next = {
          firstAt: num(cur.firstAt) ?? now,
          lastAt: now,
          count: (num(cur.count) ?? 0) + 1,
        };
        await redisCmd(['HSET', key, recordId, JSON.stringify(next)]);
        await redisCmd(['HSETNX', FUNNEL_KEY.META, META_FIELD.STARTED_AT, String(now)]);
        await redisCmd(['HSET', FUNNEL_KEY.META, META_FIELD.SCHEMA, String(FUNNEL_SCHEMA)]);
        return { ok: true, counted: true };
      } catch (e) {
        // 計測の失敗で顧客の画面を壊さない
        return { ok: false, counted: false, reason: 'write_failed' };
      }
    },

    /**
     * 1 レコードぶん読む。**読めなければ `available:false`**
     * （呼び出し側は「未確認」と出す。0 回と断定しない）。
     */
    async read({ recordId } = {}) {
      if (!RECORD_ID_RE.test(String(recordId || ''))) {
        return { available: false, reason: 'bad_record_id', row: null };
      }
      try {
        const [cta, click, page, startedAt] = await Promise.all([
          readOne(FUNNEL_KEY.CTA, recordId),
          readOne(FUNNEL_KEY.CLICK, recordId),
          readOne(FUNNEL_KEY.PAGE, recordId),
          redisCmd(['HGET', FUNNEL_KEY.META, META_FIELD.STARTED_AT]),
        ]);
        const flat = {
          cta_first_at: cta && cta.firstAt, cta_last_at: cta && cta.lastAt, cta_views: cta && cta.count,
          click_first_at: click && click.firstAt, click_last_at: click && click.lastAt, clicks: click && click.count,
          page_first_at: page && page.firstAt, page_last_at: page && page.lastAt, page_views: page && page.count,
        };
        return {
          available: true,
          /** 計測を始めた時刻。これより前の閲覧は観測できていない */
          startedAtMs: num(startedAt),
          row: shapeFunnelRow(flat),
        };
      } catch {
        return { available: false, reason: 'read_failed', row: null };
      }
    },
  };
}
