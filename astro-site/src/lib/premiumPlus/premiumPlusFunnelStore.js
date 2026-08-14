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
  /** 決済開始（申込フォームが Function へ到達した時点。サーバー側イベント） */
  CHECKOUT: `${FUNNEL_NAMESPACE}:checkout`,
  /** 購入完了（入金確認の確定。**サーバー側の確定イベントのみ**） */
  PURCHASE: `${FUNNEL_NAMESPACE}:purchase`,
  META: `${FUNNEL_NAMESPACE}:meta`,
  /** 期間集計用の日次カウンタ（**recordId を含まない**集計値のみ） */
  DAILY: `${FUNNEL_NAMESPACE}:daily`,
});

/** 記録する行動 */
export const FUNNEL_EVENT = Object.freeze({
  CTA_VIEW: 'cta_view',
  CTA_CLICK: 'cta_click',
  PAGE_VIEW: 'page_view',
  /** 決済開始。**サーバー側**（申込フォームが Function へ到達した時点）で記録する */
  CHECKOUT_START: 'checkout_start',
  /** 購入完了。**サーバー側の確定イベントのみ**（入金確認が Airtable で検証された後）*/
  PURCHASE: 'purchase',
});

/** 画面・集計で使う段階の並び（表示 → クリック → 到達 → 決済開始 → 購入完了） */
export const FUNNEL_EVENT_ORDER = Object.freeze([
  FUNNEL_EVENT.CTA_VIEW, FUNNEL_EVENT.CTA_CLICK, FUNNEL_EVENT.PAGE_VIEW,
  FUNNEL_EVENT.CHECKOUT_START, FUNNEL_EVENT.PURCHASE,
]);

export const FUNNEL_EVENT_LABEL = Object.freeze({
  cta_view: '表示',
  cta_click: 'クリック',
  page_view: '商品ページ到達',
  checkout_start: '決済開始',
  purchase: '購入完了',
});

const KEY_OF = Object.freeze({
  [FUNNEL_EVENT.CTA_VIEW]: FUNNEL_KEY.CTA,
  [FUNNEL_EVENT.CTA_CLICK]: FUNNEL_KEY.CLICK,
  [FUNNEL_EVENT.PAGE_VIEW]: FUNNEL_KEY.PAGE,
  [FUNNEL_EVENT.CHECKOUT_START]: FUNNEL_KEY.CHECKOUT,
  [FUNNEL_EVENT.PURCHASE]: FUNNEL_KEY.PURCHASE,
});

/**
 * ── CTA の導線（クリック元）──────────────────────────────────
 *
 * 同じ Premium Plus の CTA でも、どこで押されたかで意味が違う:
 *   `dashboard`   … ダッシュボードの「会員限定のご案内を見る」
 *   `sanrenpuku`  … 三連複会員ページの Premium Plus 案内枠
 *   `plus_page`   … Premium Plus 商品ページ内の購入ボタン
 *
 * ⚠️ **固定 allow-list。クライアントが送ってきた任意の値は保存しない。**
 *    ここに無い値は「導線の指定なし」として扱い、**合計にだけ**数える
 *    （推測でどれかへ振り分けない）。
 */
export const FUNNEL_SOURCE = Object.freeze({
  DASHBOARD: 'dashboard',
  SANRENPUKU: 'sanrenpuku',
  PLUS_PAGE: 'plus_page',
});

/** 集計・表示で使う導線の並び（画面がベタ書きしないための単一源） */
export const FUNNEL_SOURCE_ORDER = Object.freeze([
  FUNNEL_SOURCE.DASHBOARD,
  FUNNEL_SOURCE.SANRENPUKU,
  FUNNEL_SOURCE.PLUS_PAGE,
]);

export const FUNNEL_SOURCE_LABEL = Object.freeze({
  dashboard: 'ダッシュボード',
  sanrenpuku: '三連複ページ',
  plus_page: 'Premium Plus 商品ページ内',
  /** 決済開始の導線が複数あって購入をどちらへも寄せられない。**推測しない** */
  ambiguous: '導線を特定できず',
  /** 導線別の計測を始める前に記録された分。**推測で振り分けない** */
  legacy: 'クリック元不明（計測前）',
  /** 計測開始後に source なしで届いた分。legacy と混ぜない */
  noSource: 'クリック元なし',
});

/**
 * ── ⚠️ 導線には**性質の違う 2 種類**がある ──────────────────────────
 *
 * - `entry`   … 商品ページ**へ送る**導線（ダッシュボード / 三連複ページ）。
 *               表示 → クリック → 商品ページ到達 が一本の流れになる。
 * - `on_page` … 商品ページ**の中**にある導線（購入ボタン）。
 *               到達は**この導線より上流**なので「クリック → 到達」は成立しない。
 *
 * これを区別せずに同じ表で並べると、商品ページ内の導線が
 * **「到達 0 名 / クリック→到達 0%」**に見える。実際は 0 ではなく
 * **その指標が存在しない**（`null` = 未確定）。ここを混ぜてはいけない。
 */
export const FUNNEL_SOURCE_KIND = Object.freeze({
  ENTRY: 'entry',
  ON_PAGE: 'on_page',
});

export const FUNNEL_SOURCE_KIND_OF = Object.freeze({
  dashboard: FUNNEL_SOURCE_KIND.ENTRY,
  sanrenpuku: FUNNEL_SOURCE_KIND.ENTRY,
  plus_page: FUNNEL_SOURCE_KIND.ON_PAGE,
});

export const FUNNEL_SOURCE_KIND_LABEL = Object.freeze({
  entry: '商品ページへの流入',
  on_page: '商品ページ内',
});

/** 商品ページへ**送る**導線だけ（`?from=` に載ってよいのはこれだけ） */
export const ENTRY_SOURCE_ORDER = Object.freeze(
  FUNNEL_SOURCE_ORDER.filter((s) => FUNNEL_SOURCE_KIND_OF[s] === FUNNEL_SOURCE_KIND.ENTRY),
);

/** その導線が商品ページ内のものか */
export function isOnPageSource(source) {
  return FUNNEL_SOURCE_KIND_OF[source] === FUNNEL_SOURCE_KIND.ON_PAGE;
}

const SOURCE_SET = new Set(FUNNEL_SOURCE_ORDER);
const ENTRY_SOURCE_SET = new Set(ENTRY_SOURCE_ORDER);

/**
 * 導線別集計のスキーマ版。**この版で書かれた記録だけが内訳を持つ。**
 *
 * `sv` を持たない値は導線別計測より前のもので、**全量が legacy（クリック元不明）**。
 * 「合計 − 内訳の和」で不明を出してはいけない（下記）。
 */
export const FUNNEL_SOURCE_SCHEMA = 1;

/**
 * ── ⚠️ 合計（aggregate）と導線別（bySource）は**意味が違う** ────────────
 *
 * - **合計**: 「その人がその種別で反応した 30 分窓の数」。
 *   導線に関係なく 1 つの窓で 1 回。**互換のためこの意味を変えない。**
 * - **導線別**: 「その導線で反応した 30 分窓の数」を導線ごとに数える。
 *
 * したがって **導線別の和が合計を超えることがある**（正常）。
 * 例: dashboard をクリックした 10 分後に sanrenpuku をクリック
 *     → 合計 1 / dashboard 1 / sanrenpuku 1（和 2 > 合計 1）
 *
 * **だから「合計 − 内訳の和」で不明を出してはいけない。負になる。**
 * 不明は次の 2 つを**明示的に別々へ**数える:
 *   - `legacy`   … 導線別計測より前の記録（`sv` が無い分）。**過去データは書き換えない**
 *   - `noSource` … 導線別計測が始まったあと、source なしで届いた記録
 */
const LEGACY_NOTE = '導線別計測より前の記録';

/**
 * 受け取った source を allow-list で検証する。
 * **該当しなければ null**（= 導線の指定なし。合計にだけ数える）。
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeFunnelSource(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return SOURCE_SET.has(s) ? s : null;
}

/**
 * URL の `?from=` 用。**流入導線（entry）だけ**を受け付ける。
 *
 * ⚠️ `?from=plus_page` を通してはいけない。商品ページ内の導線は
 *    「商品ページへ来た経路」ではないので、URL から名乗らせると
 *    到達の内訳が汚れる（誰でも付けられるパラメータでもある）。
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeEntrySource(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return ENTRY_SOURCE_SET.has(s) ? s : null;
}

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

/** まとめ読みの 1 コマンドあたり件数（Upstash のリクエストが肥大しないように） */
export const READ_CHUNK = 200;

/** 期間集計の窓（日）。画面はこの順で出す */
export const FUNNEL_WINDOW_DAYS = Object.freeze([1, 7, 30]);

/** 日次カウンタを保持する日数。これより古いフィールドは書込み時に掃除する */
export const DAILY_RETENTION_DAYS = 91;

/** 購入の帰属が確定しないときの印（どの導線へも寄せない） */
export const FUNNEL_SOURCE_AMBIGUOUS = 'ambiguous';

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

/** 保存された 3 種別 → `shapeFunnelRow` が読む平たい形（**組み立ては 1 か所**） */
export function flatten({ cta, click, page, checkout, purchase } = {}) {
  const out = {};
  for (const [p, v] of [['cta', cta], ['click', click], ['page', page],
    ['checkout', checkout], ['purchase', purchase]]) {
    out[`${p}_first_at`] = v && v.firstAt;
    out[`${p}_last_at`] = v && v.lastAt;
    out[`${p}_count`] = v && v.count;
    out[`${p}_by_source`] = v && v.bySource;
    out[`${p}_no_source`] = v && v.noSource;
    out[`${p}_legacy`] = v && v.legacy;
    out[`${p}_sv`] = v && v.sv;
  }
  return out;
}

/** 1 レコードぶんの生データ → 表示用（**数えられていないものは null**） */
export function shapeFunnelRow(raw) {
  const r = raw || {};
  const pick = (p) => ({
    firstAtMs: num(r[`${p}_first_at`]),
    lastAtMs: num(r[`${p}_last_at`]),
    count: num(r[`${p}_count`]),
    // 導線別の内訳。**古いデータには無い**
    bySource: shapeBySource(r[`${p}_by_source`]),
    // source なしで届いた分（導線別計測が始まったあと）。legacy とは別枠
    noSource: shapeBucket(r[`${p}_no_source`]),
    // 導線別計測より前にあった回数。**引き算では出さない**
    legacyCount: resolveLegacyCount(r[`${p}_sv`], r[`${p}_legacy`], r[`${p}_count`]),
  });
  return {
    cta: pick('cta'), click: pick('click'), page: pick('page'),
    checkout: pick('checkout'), purchase: pick('purchase'),
  };
}

/** 1 バケット（導線 1 つ / noSource）→ 表示用 */
export function shapeBucket(raw) {
  const e = raw && typeof raw === 'object' ? raw : null;
  if (!e) return null;
  const count = num(e.count);
  if (count === null || count <= 0) return null;
  return { firstAtMs: num(e.firstAt), lastAtMs: num(e.lastAt), count };
}

/**
 * 導線別計測より前にあった回数。
 *
 * ⚠️ **「合計 − 内訳の和」で出してはいけない。** 合計と導線別は数え方が違い
 * （合計は全導線共通の 30 分窓、導線別は導線ごとの 30 分窓）、
 * 和が合計を超えることがある。引き算すると負になる。
 *
 * - `sv` が無い = 導線別計測より前の値 → **全量が legacy**
 * - `sv` がある = 書き込み時に固定した `legacy` をそのまま使う
 */
export function resolveLegacyCount(sv, legacy, count) {
  if (num(sv) === null) return num(count) ?? 0;
  return num(legacy) ?? 0;
}

/** 保存された内訳 → 表示用（allow-list 外の鍵は捨てる） */
export function shapeBySource(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const s of FUNNEL_SOURCE_ORDER) {
    const e = src[s] && typeof src[s] === 'object' ? src[s] : null;
    if (!e) continue;
    const count = num(e.count);
    if (count === null || count <= 0) continue;
    out[s] = { firstAtMs: num(e.firstAt), lastAtMs: num(e.lastAt), count };
  }
  return out;
}

/**
 * 購入をどの導線へ帰属させるか。**推測しない。**
 *
 * 決済開始（checkout）の内訳を見て:
 *   - 導線が 1 つだけ → その導線
 *   - 2 つ以上       → `ambiguous`（どちらへも寄せない）
 *   - 0 個           → null（= 導線なし）
 *
 * @param {object|null} checkoutRaw 保存されている checkout の生データ
 * @returns {string|null}
 */
export function attributePurchaseSource(checkoutRaw) {
  const by = checkoutRaw && checkoutRaw.bySource && typeof checkoutRaw.bySource === 'object'
    ? checkoutRaw.bySource : {};
  const hit = FUNNEL_SOURCE_ORDER.filter((s) => {
    const e = by[s];
    return e && (num(e.count) ?? 0) > 0;
  });
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) return FUNNEL_SOURCE_AMBIGUOUS;
  return null;
}

/** Upstash の HGETALL は配列で返ることがある。オブジェクトへ正規化する */
export function normalizeHgetall(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out = {};
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = raw[i + 1];
    return out;
  }
  return typeof raw === 'object' ? raw : {};
}

/** 記録が 1 つでもあるか（無いなら「未確認」であって 0 ではない） */
export function hasAnyFunnelRecord(row) {
  const r = row || {};
  return [r.cta, r.click, r.page].some((x) => x && Number.isFinite(x.count) && x.count > 0);
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ミリ秒 → JST の 'YYYYMMDD'（日次カウンタの鍵） */
export function funnelDayKey(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + JST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** 日次カウンタのフィールド名。**recordId を入れない**（集計値のみ） */
export function dailyField(day, event, source) {
  return `${day}|${event}|${source || 'none'}`;
}

/** 直近 N 日ぶんの 'YYYYMMDD'（今日を含む） */
export function recentDayKeys(nowMs, days) {
  const n = Number.isFinite(days) && days > 0 ? Math.floor(days) : 1;
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(funnelDayKey(nowMs - i * 86400000));
  return out.filter(Boolean);
}

/** ミリ秒 → 'YYYY-MM-DD HH:MM'（JST）。null はそのまま null */
export function funnelJst(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + JST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 1 種別ぶんの**表示文言**（管理画面が独自に組み立てないための単一源）。
 *
 * ⚠️ **記録が無いことを「0 回」と書かない。**
 * 記録が無い理由は「本当に見ていない」だけでなく「計測を始める前だった」
 * 「Redis が読めない」もある。どれも**確認不能**であって 0 ではない。
 *
 * @param {{count:number|null, firstAtMs:number|null, lastAtMs:number|null}|null} cell
 * @param {{available?: boolean, startedAtMs?: number|null}} ctx
 */
export function describeFunnelCell(cell, { available, startedAtMs } = {}) {
  // 構造化した値も併せて返す（画面が「初回 / 最終 / 回数」を列で出せるようにする）。
  // ⚠️ measured=false のときは **count を 0 にしない**。null のまま返す。
  const blank = {
    count: null, firstAtMs: null, lastAtMs: null, firstAtJst: null, lastAtJst: null,
    sources: [], sourceTotal: null, sourceTotalDiffers: false,
    legacyCount: null, legacyLabel: FUNNEL_SOURCE_LABEL.legacy,
    noSourceCount: null, noSourceFirstAtJst: null, noSourceLastAtJst: null,
    noSourceLabel: FUNNEL_SOURCE_LABEL.noSource,
  };
  if (available === false) {
    return {
      text: '未確認',
      note: '計測データを読み取れませんでした（0 回という意味ではありません）',
      measured: false,
      ...blank,
    };
  }
  const count = cell && Number.isFinite(cell.count) ? cell.count : null;
  if (count === null || count <= 0) {
    const since = funnelJst(startedAtMs);
    return {
      text: '未確認',
      note: since
        ? `計測開始（${since} JST）以降の記録はありません。それ以前に見たかどうかは確認できません`
        : 'まだ計測記録がありません。過去に見たかどうかは確認できません',
      measured: false,
      ...blank,
    };
  }
  // ── 導線別の内訳 ────────────────────────────────────────────
  // ⚠️ **合計 − 内訳の和では出さない。** 合計と導線別は数え方が違い
  //    （合計は全導線共通の 30 分窓、導線別は導線ごとの 30 分窓）、
  //    和が合計を超えることがある。引き算すると負になる。
  //    不明は legacy（計測前）と noSource（計測後に source なし）を**別々に明示**する。
  const by = cell && cell.bySource && typeof cell.bySource === 'object' ? cell.bySource : {};
  const sources = [];
  let sourceTotal = 0;
  for (const s of FUNNEL_SOURCE_ORDER) {
    const e = by[s];
    if (!e || !Number.isFinite(e.count) || e.count <= 0) continue;
    sourceTotal += e.count;
    sources.push({
      source: s,
      label: FUNNEL_SOURCE_LABEL[s],
      count: e.count,
      firstAtJst: funnelJst(e.firstAtMs),
      lastAtJst: funnelJst(e.lastAtMs),
      firstAtMs: Number.isFinite(e.firstAtMs) ? e.firstAtMs : null,
      lastAtMs: Number.isFinite(e.lastAtMs) ? e.lastAtMs : null,
    });
  }
  const noSrc = cell && cell.noSource ? cell.noSource : null;
  const legacyCount = Number.isFinite(cell && cell.legacyCount) ? cell.legacyCount : 0;
  return {
    text: `${count} 回`,
    note: `初回 ${funnelJst(cell.firstAtMs) || '不明'} / 最終 ${funnelJst(cell.lastAtMs) || '不明'}（JST）`,
    measured: true,
    count,
    firstAtMs: Number.isFinite(cell.firstAtMs) ? cell.firstAtMs : null,
    lastAtMs: Number.isFinite(cell.lastAtMs) ? cell.lastAtMs : null,
    firstAtJst: funnelJst(cell.firstAtMs),
    lastAtJst: funnelJst(cell.lastAtMs),
    sources,
    /** 導線別の合計。**`count` と一致しないことがある**（数え方が違うため） */
    sourceTotal,
    /** 合計と導線別の和が食い違っているか（画面に注記を出すため） */
    sourceTotalDiffers: sourceTotal !== count,
    /** 導線別計測より前の記録。**引き算では出さない**（保存値または全量） */
    legacyCount,
    legacyLabel: FUNNEL_SOURCE_LABEL.legacy,
    /** 計測開始後に source なしで届いた記録。legacy とは別枠 */
    noSourceCount: noSrc && Number.isFinite(noSrc.count) ? noSrc.count : 0,
    noSourceFirstAtJst: noSrc ? funnelJst(noSrc.firstAtMs) : null,
    noSourceLastAtJst: noSrc ? funnelJst(noSrc.lastAtMs) : null,
    noSourceLabel: FUNNEL_SOURCE_LABEL.noSource,
  };
}

/**
 * 1 会員ぶんの実閲覧を管理画面用にまとめる。
 * **「表示判定」列とは別物**（判定は resolveUpsellForCustomer、ここは実測）。
 */
export function describeFunnelRow(row, { available, startedAtMs } = {}) {
  const ctx = { available, startedAtMs };
  const r = row || {};
  return {
    available: available !== false,
    startedAtJst: funnelJst(startedAtMs),
    cta: describeFunnelCell(r.cta, ctx),
    click: describeFunnelCell(r.click, ctx),
    page: describeFunnelCell(r.page, ctx),
    checkout: describeFunnelCell(r.checkout, ctx),
    purchase: describeFunnelCell(r.purchase, ctx),
    /** 1 つでも実測があるか。false = 「見ていない」ではなく「確認できない」 */
    anyMeasured: available !== false && hasAnyFunnelRecord(r),
  };
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

  /**
   * 期間集計用の日次カウンタを 1 つ進める。
   *
   * ⚠️ **recordId を入れない**（`YYYYMMDD|event|source` だけ）。
   *    個人を Redis へ増やさないため、ここは純粋な集計値。
   * 併せて保持期間より古いフィールドを 1 つ掃除する（自己クリーンアップ・状態を持たない）。
   */
  async function bumpDaily(nowMs, event, source) {
    const day = funnelDayKey(nowMs);
    if (!day) return;
    // ⚠️ 日次カウンタは**補助**。ここが失敗しても本体の記録を巻き戻さない。
    //    （HINCRBY / HDEL を持たない環境でも本体は動く）
    try {
      await redisCmd(['HINCRBY', FUNNEL_KEY.DAILY, dailyField(day, event, source), '1']);
      const stale = funnelDayKey(nowMs - DAILY_RETENTION_DAYS * 86400000);
      if (stale) await redisCmd(['HDEL', FUNNEL_KEY.DAILY, dailyField(stale, event, source)]);
    } catch {
      // 期間集計が欠けるだけ。本体の実閲覧は保持する
    }
  }

  return {
    /**
     * 1 件記録する。**過剰計上は DEDUPE_MS でサーバー側が潰す**。
     * 失敗しても例外は投げない（計測で画面を壊さない）。
     *
     * @returns {Promise<{ok:boolean, counted:boolean, reason?:string}>}
     */
    async record({ recordId, event, nowMs, userAgent, authenticated, adminPreview, source } = {}) {
      const gate = shouldRecordFunnelEvent({ recordId, event, userAgent, authenticated, adminPreview });
      if (!gate.ok) return { ok: true, counted: false, reason: gate.reason };

      const now = num(nowMs) ?? 0;
      const key = KEY_OF[event];
      // allow-list 外は null（= 導線の指定なし）。**任意の文字列を保存しない**
      const src = normalizeFunnelSource(source);
      try {
        const cur = (await readOne(key, recordId)) || {};
        const tracked = num(cur.sv) !== null;

        // ── 重複除外は **種別 × 導線** 単位 ───────────────────────
        // dashboard を押した 10 分後に sanrenpuku を押したら、**両方 1 回ずつ**数える。
        // 同じ導線の 30 分以内の再クリックだけを落とす。
        const bucket = src || 'noSource';
        const curBucket = src
          ? ((cur.bySource && cur.bySource[src]) || null)
          : (cur.noSource || null);
        const bucketLastAt = curBucket ? num(curBucket.lastAt) : null;
        const bucketDeduped = bucketLastAt !== null && now - bucketLastAt < DEDUPE_MS;

        // 合計は**従来どおり**（全導線共通の 30 分窓）。互換のため意味を変えない。
        // ⚠️ 合計が落ちても導線別は数える。だから和が合計を超えることがある（正常）。
        const aggLastAt = num(cur.lastAt);
        const aggDeduped = aggLastAt !== null && now - aggLastAt < DEDUPE_MS;

        if (aggDeduped && bucketDeduped) {
          return { ok: true, counted: false, reason: 'deduped', bucket };
        }

        // 既存の内訳を**そのまま**引き継ぐ（過去データを書き換えない）
        const curBy = cur.bySource && typeof cur.bySource === 'object' ? cur.bySource : {};
        const bySource = {};
        for (const s of FUNNEL_SOURCE_ORDER) {
          const e = curBy[s] && typeof curBy[s] === 'object' ? curBy[s] : null;
          if (!e) continue;
          bySource[s] = {
            firstAt: num(e.firstAt) ?? null,
            lastAt: num(e.lastAt) ?? null,
            count: num(e.count) ?? 0,
          };
        }
        const curNo = cur.noSource && typeof cur.noSource === 'object' ? cur.noSource : null;
        let noSource = curNo
          ? { firstAt: num(curNo.firstAt) ?? null, lastAt: num(curNo.lastAt) ?? null, count: num(curNo.count) ?? 0 }
          : null;

        if (!bucketDeduped) {
          if (src) {
            const e = bySource[src] || null;
            bySource[src] = {
              firstAt: (e && num(e.firstAt)) ?? now,
              lastAt: now,
              count: ((e && num(e.count)) ?? 0) + 1,
            };
          } else {
            // source なしで届いた分は **legacy とは別に**明示して数える
            noSource = {
              firstAt: (noSource && num(noSource.firstAt)) ?? now,
              lastAt: now,
              count: ((noSource && num(noSource.count)) ?? 0) + 1,
            };
          }
        }

        // 導線別計測より前にあった分を **1 度だけ** legacy として固定する。
        // これは分類の変更ではなく「内訳が無いまま存在した回数」の保存。
        // ⚠️ 既に sv がある値の legacy は触らない（過去データを書き換えない）。
        const legacy = tracked ? (num(cur.legacy) ?? 0) : (num(cur.count) ?? 0);

        const next = {
          firstAt: num(cur.firstAt) ?? now,
          lastAt: aggDeduped ? aggLastAt : now,
          count: (num(cur.count) ?? 0) + (aggDeduped ? 0 : 1),
          sv: FUNNEL_SOURCE_SCHEMA,
          legacy,
          ...(Object.keys(bySource).length ? { bySource } : {}),
          ...(noSource ? { noSource } : {}),
        };
        await redisCmd(['HSET', key, recordId, JSON.stringify(next)]);
        await redisCmd(['HSETNX', FUNNEL_KEY.META, META_FIELD.STARTED_AT, String(now)]);
        await redisCmd(['HSET', FUNNEL_KEY.META, META_FIELD.SCHEMA, String(FUNNEL_SCHEMA)]);
        await bumpDaily(now, event, src);
        return { ok: true, counted: true, bucket, aggregateCounted: !aggDeduped };
      } catch (e) {
        // 計測の失敗で顧客の画面を壊さない
        return { ok: false, counted: false, reason: 'write_failed' };
      }
    },

    /**
     * ── 購入完了を記録する（**サーバー側の確定イベント専用**）─────────
     *
     * 表示・クリックと違い、購入は **一度きり**でなければならない。
     * Airtable Automation の再実行 / Webhook 再送 / 画面の再読込で
     * 何度呼ばれても **同じ注文は 1 回しか計上しない**。
     *
     * 冪等性の鍵:
     *   - `orderKey` があれば **(recordId, orderKey) につき 1 回**
     *   - 無ければ **recordId につき 1 回**（この商品は単品購入のため）
     *
     * 導線は**推測しない**。決済開始で記録した source を引き継ぎ、
     * 複数あって決められないときは `ambiguous` に置く。
     *
     * @param {{recordId:string, nowMs:number, orderKey?:string|null}} input
     * @returns {Promise<{ok:boolean, counted:boolean, reason?:string, source?:string|null}>}
     */
    async record_purchase({ recordId, nowMs, orderKey } = {}) {
      if (!RECORD_ID_RE.test(String(recordId || ''))) {
        return { ok: true, counted: false, reason: 'bad_record_id' };
      }
      const now = num(nowMs) ?? 0;
      const key = FUNNEL_KEY.PURCHASE;
      const slot = String(orderKey || '').trim() || 'default';
      try {
        const cur = (await readOne(key, recordId)) || {};
        const orders = cur.orders && typeof cur.orders === 'object' ? cur.orders : {};
        // ⚠️ ここが二重計上の唯一の防壁。既に見た注文なら**何も書かない**
        if (orders[slot]) {
          return { ok: true, counted: false, reason: 'already_counted', source: cur.attributedSource ?? null };
        }

        // 導線は決済開始の記録から引き継ぐ（推測しない）
        const checkout = (await readOne(FUNNEL_KEY.CHECKOUT, recordId)) || null;
        const src = attributePurchaseSource(checkout);

        const next = {
          firstAt: num(cur.firstAt) ?? now,
          lastAt: now,
          count: (num(cur.count) ?? 0) + 1,
          sv: FUNNEL_SOURCE_SCHEMA,
          legacy: num(cur.sv) !== null ? (num(cur.legacy) ?? 0) : (num(cur.count) ?? 0),
          orders: { ...orders, [slot]: now },
          attributedSource: src,
        };
        if (src && src !== FUNNEL_SOURCE_AMBIGUOUS) {
          const by = cur.bySource && typeof cur.bySource === 'object' ? { ...cur.bySource } : {};
          const e = by[src] || null;
          by[src] = {
            firstAt: (e && num(e.firstAt)) ?? now,
            lastAt: now,
            count: ((e && num(e.count)) ?? 0) + 1,
          };
          next.bySource = by;
        } else if (src === FUNNEL_SOURCE_AMBIGUOUS) {
          const a = cur.ambiguous || null;
          next.ambiguous = {
            firstAt: (a && num(a.firstAt)) ?? now,
            lastAt: now,
            count: ((a && num(a.count)) ?? 0) + 1,
          };
          if (cur.bySource) next.bySource = cur.bySource;
        } else {
          const n = cur.noSource || null;
          next.noSource = {
            firstAt: (n && num(n.firstAt)) ?? now,
            lastAt: now,
            count: ((n && num(n.count)) ?? 0) + 1,
          };
          if (cur.bySource) next.bySource = cur.bySource;
        }

        await redisCmd(['HSET', key, recordId, JSON.stringify(next)]);
        await redisCmd(['HSETNX', FUNNEL_KEY.META, META_FIELD.STARTED_AT, String(now)]);
        await bumpDaily(now, FUNNEL_EVENT.PURCHASE, src);
        return { ok: true, counted: true, source: src };
      } catch {
        return { ok: false, counted: false, reason: 'write_failed' };
      }
    },

    /**
     * 期間集計（今日 / 7 日 / 30 日）を読む。
     * **件数**であり人数ではない（画面で必ず明示する）。
     */
    async readDaily({ nowMs, windows = FUNNEL_WINDOW_DAYS } = {}) {
      try {
        const all = await redisCmd(['HGETALL', FUNNEL_KEY.DAILY]);
        return { available: true, entries: normalizeHgetall(all), windows, nowMs };
      } catch {
        return { available: false, reason: 'read_failed', entries: null, windows, nowMs };
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
        const flat = flatten({ cta, click, page });
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

    /**
     * 複数レコードをまとめて読む（管理一覧用）。
     *
     * 1 件ずつ読むと一覧の行数だけ往復が増えて管理画面がタイムアウトする。
     * **HMGET で種別ごと 1 回**に畳む（3 種別 + META = 4 往復 / チャンク）。
     *
     * 読めなければ `available:false`。**そのとき行を 0 回にしない**
     * （呼び出し側は全員「未確認」と出す）。
     *
     * @returns {Promise<{available:boolean, startedAtMs:number|null, rows:Map<string,object>|null, reason?:string}>}
     */
    async readMany({ recordIds } = {}) {
      const ids = [...new Set((recordIds || []).map((x) => String(x || '')))]
        .filter((id) => RECORD_ID_RE.test(id));
      if (ids.length === 0) return { available: true, startedAtMs: null, rows: new Map() };

      try {
        const startedAt = await redisCmd(['HGET', FUNNEL_KEY.META, META_FIELD.STARTED_AT]);
        const rows = new Map();
        // Upstash の 1 コマンドが際限なく長くならないよう分割する
        for (let i = 0; i < ids.length; i += READ_CHUNK) {
          const chunk = ids.slice(i, i + READ_CHUNK);
          const [cta, click, page, checkout, purchase] = await Promise.all([
            redisCmd(['HMGET', FUNNEL_KEY.CTA, ...chunk]),
            redisCmd(['HMGET', FUNNEL_KEY.CLICK, ...chunk]),
            redisCmd(['HMGET', FUNNEL_KEY.PAGE, ...chunk]),
            redisCmd(['HMGET', FUNNEL_KEY.CHECKOUT, ...chunk]),
            redisCmd(['HMGET', FUNNEL_KEY.PURCHASE, ...chunk]),
          ]);
          const at = (arr, k) => {
            const v = Array.isArray(arr) ? arr[k] : null;
            if (v === null || v === undefined) return null;
            try { return JSON.parse(typeof v === 'string' ? v : String(v)); } catch { return null; }
          };
          chunk.forEach((id, k) => {
            const c = at(cta, k); const cl = at(click, k); const p = at(page, k);
            const co = at(checkout, k); const pu = at(purchase, k);
            rows.set(id, shapeFunnelRow(flatten({ cta: c, click: cl, page: p, checkout: co, purchase: pu })));
          });
        }
        return { available: true, startedAtMs: num(startedAt), rows };
      } catch {
        return { available: false, reason: 'read_failed', startedAtMs: null, rows: null };
      }
    },
  };
}
