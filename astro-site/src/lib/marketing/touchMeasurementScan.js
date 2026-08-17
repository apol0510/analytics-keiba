/**
 * touchMeasurementScan.js — touch 別実績を**ページに割って**数える（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * `action=touchMeasurement` は配信台帳を**全件一括**で読み、受信者 × step ぶんの
 * DeliveryKey をその場で全部計算していた。2026-08-17 に配信行が 610 まで増えた時点で
 * **504（Inactivity Timeout）**。最終的に 14,000 名規模まで増えるので、
 * 「上限を上げる／timeout を延ばす」では必ずまた壊れる。
 *
 * ── 設計 ──────────────────────────────────────────────────────
 * 1 リクエスト = **1 ページだけ**（Airtable の offset を cursor にする）。
 *   - 1 ページで読む行数は上限つき（`TOUCH_SCAN_MAX_PAGE`）
 *   - DeliveryKey の計算も、イベント索引の読み出しも**そのページの分だけ**
 *   - 呼び出し側は `cursor` が null になるまで呼び、ここの `mergeTouchPage` で足す
 *
 * ⚠️ **二重集計しない**。ページは `pageIndex` で識別し、同じページを 2 回足しても
 *    結果は変わらない（再試行・重複起動しても数が膨らまない）。
 * ⚠️ 率（deliveryRate / openRate）は**合計してから 1 回だけ**計算する。
 *    ページごとの率を平均すると、行数の違いで嘘になる。
 * ⚠️ 索引が読めなかったページが 1 つでもあれば `measurementAvailable: false`
 *    （読めなかったぶんを 0 件として通さない）。
 */

/** 1 ページの既定行数（Airtable 1 ページ = 100 行の倍数にしておく） */
export const TOUCH_SCAN_DEFAULT_PAGE = 200;

/**
 * 1 ページの上限。イベント索引の bounded read（`MAX_READ_KEYS` = 500）と揃える。
 * これ以上を 1 回で読むと、行数が増えたときに再び timeout する。
 */
export const TOUCH_SCAN_MAX_PAGE = 500;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 要求されたページ行数を安全な範囲へ丸める（**黙って全件にしない**） */
export function resolveScanPageSize(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return TOUCH_SCAN_DEFAULT_PAGE;
  return Math.min(Math.floor(n), TOUCH_SCAN_MAX_PAGE);
}

/** 集計の初期値（JSON でそのまま持ち回せる形） */
export function emptyTouchScan() {
  return {
    /** 足したページ番号（**重複を弾くため**に持つ） */
    mergedPages: [],
    /** touch 番号 → 件数 */
    byTouch: {},
    rows: 0,
    measurementAvailable: true,
  };
}

const EMPTY_COUNTS = { sent: 0, delivered: 0, opened: 0, measured: 0, unknown: 0 };

/**
 * 1 ページぶんの集計を足す。**同じ `pageIndex` を 2 回渡しても増えない**。
 *
 * @param {object} acc  `emptyTouchScan()` の戻り、または前回の戻り
 * @param {{pageIndex: number, touches: object[], measurementAvailable?: boolean,
 *          rows?: number}} page  `summarizeByTouch` の結果 + ページ番号
 */
export function mergeTouchPage(acc, page) {
  const a = acc && typeof acc === 'object' ? acc : emptyTouchScan();
  const merged = Array.isArray(a.mergedPages) ? a.mergedPages.slice() : [];
  const p = page && typeof page === 'object' ? page : null;
  const idx = p && Number.isInteger(Number(p.pageIndex)) ? Number(p.pageIndex) : null;
  if (idx === null) return a;
  // ⚠️ 同じページの再送は**無視**（重複集計 0）
  if (merged.includes(idx)) return a;

  const byTouch = { ...(a.byTouch || {}) };
  for (const t of Array.isArray(p.touches) ? p.touches : []) {
    const key = String(num(t.touch));
    const cur = byTouch[key] || {
      touch: num(t.touch),
      campaignId: t.campaignId || null,
      step: t.step === null || t.step === undefined ? null : num(t.step),
      ...EMPTY_COUNTS,
    };
    byTouch[key] = {
      ...cur,
      sent: cur.sent + num(t.sent),
      delivered: cur.delivered + num(t.delivered),
      opened: cur.opened + num(t.opened),
      measured: cur.measured + num(t.measured),
      unknown: cur.unknown + num(t.unknown),
    };
  }
  merged.push(idx);
  return {
    mergedPages: merged.sort((x, y) => x - y),
    byTouch,
    rows: num(a.rows) + num(p.rows),
    // 1 ページでも索引を読めていなければ「計測できていない」
    measurementAvailable: a.measurementAvailable === true && p.measurementAvailable !== false,
  };
}

/**
 * 集計を画面・報告の形へ落とす。**率はここで 1 回だけ**計算する。
 * 返す形は `summarizeByTouch` と同じ（既存の読み手をそのまま使える）。
 */
export function finalizeTouchScan(acc) {
  const a = acc && typeof acc === 'object' ? acc : emptyTouchScan();
  const list = Object.values(a.byTouch || {})
    .sort((x, y) => num(x.touch) - num(y.touch))
    .map((x) => ({
      ...x,
      deliveryRate: x.sent > 0 ? x.delivered / x.sent : null,
      openRate: x.delivered > 0 ? x.opened / x.delivered : null,
      rateBasis: { deliveryRate: 'sent', openRate: 'delivered' },
    }));

  const totals = list.reduce((s, x) => ({
    sent: s.sent + num(x.sent),
    delivered: s.delivered + num(x.delivered),
    opened: s.opened + num(x.opened),
    measured: s.measured + num(x.measured),
    unknown: s.unknown + num(x.unknown),
  }), { ...EMPTY_COUNTS });

  return {
    measurementAvailable: a.measurementAvailable === true,
    touches: list,
    totals: {
      ...totals,
      deliveryRate: totals.sent > 0 ? totals.delivered / totals.sent : null,
      openRate: totals.delivered > 0 ? totals.opened / totals.delivered : null,
      rateBasis: { deliveryRate: 'sent', openRate: 'delivered' },
    },
    /** click は provider 側 OFF。**計測していない**（0 ではない） */
    clickMeasured: false,
    scan: {
      pages: Array.isArray(a.mergedPages) ? a.mergedPages.length : 0,
      rows: num(a.rows),
    },
  };
}

/**
 * 全ページを歩いて 1 つにまとめる（呼び出し側は「1 ページ取る関数」だけ渡す）。
 *
 * @param {{fetchPage: (cursor: string|null) => Promise<object>, maxPages?: number}} input
 *   `fetchPage` は `{touches, measurementAvailable, rows, scan:{pageIndex, cursor, done}}` を返すこと。
 * @returns {Promise<object>} `finalizeTouchScan` の戻り + `complete`
 *
 * ⚠️ `maxPages` に達しても**黙って打ち切らない**（`complete: false` を返す）。
 */
export async function scanAllTouchPages({ fetchPage, maxPages = 200 } = {}) {
  let acc = emptyTouchScan();
  let cursor = null;
  let pages = 0;
  let complete = false;
  const seen = new Set();
  while (pages < maxPages) {
    // eslint-disable-next-line no-await-in-loop -- cursor 方式なので直列
    const page = await fetchPage(cursor);
    if (!page) break;
    const scan = page.scan || {};
    acc = mergeTouchPage(acc, {
      pageIndex: Number(scan.pageIndex),
      touches: page.touches,
      measurementAvailable: page.measurementAvailable,
      rows: Number(scan.rows),
    });
    pages += 1;
    const next = scan.cursor ? String(scan.cursor) : null;
    // 同じ cursor が返り続ける実装事故で無限ループしない
    if (!next || seen.has(next)) { complete = !next; break; }
    seen.add(next);
    cursor = next;
  }
  return { ...finalizeTouchScan(acc), complete };
}

/**
 * `action=touchMeasurement`（**ページを跨がない呼び出し**）が 1 回で歩いてよいページ数。
 *
 * ⚠️ ここを増やして「全件を 1 リクエストで」に戻さない。610 行で 504 になったのが発端で、
 *    行数は 14,000 名規模まで増える。**足りなければ数を返さない**のが正しい振る舞い。
 */
export const MEASUREMENT_INLINE_MAX_PAGES = 2;

/** 数を返せなかった理由（固定コード） */
export const MEASUREMENT_INCOMPLETE = 'measurement_requires_scan';

/**
 * ページ集計を **「全体の数」として返してよいかどうか**で 2 つに分ける。
 *
 * ⚠️ **部分集計を `touches` / `totals` の形で返さない。**
 *    旧来 `action=touchMeasurement` は「全体の集計」を返す約束だった。
 *    ここで 1 ページ分を同じ形で返すと、読み手（runbook の curl / 将来の画面）が
 *    **一部を全体として読む**。数が足りないときは**数そのものを返さない**。
 *
 * @param {{scan: object, budgetPages: number}} input
 *   `scan` … `scanAllTouchPages()` の戻り（`complete` を含む）
 * @returns {{ok: boolean, body: object}} `ok:false` なら数は入っていない
 */
export function buildInlineMeasurementResult({ scan, budgetPages = MEASUREMENT_INLINE_MAX_PAGES } = {}) {
  const r = scan && typeof scan === 'object' ? scan : null;
  if (!r || r.complete !== true) {
    return {
      ok: false,
      body: {
        /** 数は**入れない**（部分を全体と誤読させない） */
        complete: false,
        code: MEASUREMENT_INCOMPLETE,
        scannedPages: r && r.scan ? r.scan.pages : 0,
        scannedRows: r && r.scan ? r.scan.rows : 0,
        budgetPages,
        error: '配信件数が多く、1 回の呼び出しでは全体を数え切れません。'
          + 'ページを辿る呼び出し（action=touchMeasurementPage）か '
          + '`npm run scan:touch-measurement` を使ってください。',
      },
    };
  }
  return {
    ok: true,
    body: {
      complete: true,
      measurementAvailable: r.measurementAvailable,
      touches: r.touches,
      totals: r.totals,
      clickMeasured: r.clickMeasured,
      scannedPages: r.scan.pages,
      scannedRows: r.scan.rows,
      budgetPages,
    },
  };
}

export default mergeTouchPage;
