/**
 * premiumPlusFunnelClient.js — 実閲覧を **1 か所から** 記録するブラウザ側の薄い層
 *
 * ## なぜキュー方式か
 *
 * CTA を出す側は 2 種類ある:
 *   - `PremiumPlusStageTeaser.astro` … `is:inline` の素の script（バンドルされない）
 *   - `dashboard.astro` … バンドルされる module script
 *
 * inline 側から module を import できないため、各所に fetch を書き写すと
 * 「送っている条件」が分かれて必ずズレる。そこで **inline 側は配列へ push するだけ**、
 * 送信の判断はこのモジュールだけが持つ（analytics タグと同じキュー方式）。
 *
 *     window.__akPpFunnelQueue = window.__akPpFunnelQueue || [];
 *     window.__akPpFunnelQueue.push({ event: 'cta_view', el: card });
 *
 * `installPlusFunnel()` がキューを引き取り、以後の push は即時送信になる。
 * **読み込み順に依存しない**（先に push されても取りこぼさない）。
 *
 * ## 「表示」は描画ではなく**実際に見えたこと**にする
 *
 * `el` を渡すと IntersectionObserver で **画面に入ったときだけ** 記録する。
 * DOM に足しただけ・折りたたみの中・画面外は「表示した」と数えない
 * （管理画面の「表示判定」列と重複した意味にならないようにする）。
 *
 * ## 数えすぎない / 壊さない
 *
 * - **1 ページ表示につき種別ごと 1 回**（サーバー側にも `DEDUPE_MS` の防御がある）
 * - 送信は fire-and-forget。失敗しても CTA のリンク遷移を止めない
 * - クリックは `keepalive` で送る（遷移で中断されないため）
 *
 * ## 送らないもの
 *
 * イベント名だけを送る。**recordId も Email も送らない**
 * （サーバーが `ak_session` から解決する。クライアント申告は信用されない）。
 */

import { FUNNEL_EVENT } from './premiumPlusFunnelStore.js';

/** inline script が push する先（この名前を変えるときは teaser 側も直す） */
export const FUNNEL_QUEUE_KEY = '__akPpFunnelQueue';

export const FUNNEL_ENDPOINT = '/api/pp-funnel.json';

/** 二重 install 防止 */
export const FUNNEL_INSTALLED_KEY = '__akPpFunnelInstalled';

/** CTA が「見えた」と数える表示割合 */
export const VIEW_RATIO = 0.5;

const ALLOWED = new Set([FUNNEL_EVENT.CTA_VIEW, FUNNEL_EVENT.CTA_CLICK, FUNNEL_EVENT.PAGE_VIEW]);

/**
 * キューに入った値を `{ event, el }` へ正規化する。
 * 文字列 1 つ（`'cta_click'`）でも受ける。**未知のイベントは捨てる**。
 */
export function normalizeQueueItem(raw) {
  if (typeof raw === 'string') {
    return ALLOWED.has(raw) ? { event: raw, el: null, source: null } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const event = String(raw.event || '');
  if (!ALLOWED.has(event)) return null;
  // 導線はそのまま運ぶだけ。**正しさの判定はサーバー**（allow-list）。
  // ここで検証すると、クライアントを信用したことになる。
  const source = typeof raw.source === 'string' ? raw.source : null;
  return { event, el: raw.el || null, source };
}

/**
 * 送信の判断を持つ本体。**I/O は注入**（テストで DOM も fetch も使わない）。
 *
 * @param {{ post: (event:string)=>void, observe?: (el:any, onVisible:()=>void)=>void }} io
 */
export function createFunnelClient({ post, observe } = {}) {
  if (typeof post !== 'function') throw new TypeError('post が必要です');
  /** このページ表示で送った種別（種別ごと 1 回だけ） */
  const sent = new Set();

  function send(event, source) {
    if (!ALLOWED.has(event) || sent.has(event)) return false;
    sent.add(event);
    try { post(event, source); } catch { /* 計測の失敗で画面を壊さない */ }
    return true;
  }

  return {
    /** キューの 1 件を処理する。`el` があれば「見えたとき」まで待つ */
    accept(raw) {
      const item = normalizeQueueItem(raw);
      if (!item) return false;
      if (item.el && typeof observe === 'function') {
        // まだ数えない。画面に入った時点で send する
        observe(item.el, () => send(item.event, item.source));
        return true;
      }
      return send(item.event, item.source);
    },
    /** 送信済みの種別（テスト・デバッグ用） */
    sentEvents() { return [...sent]; },
  };
}

/** 既定の送信（fetch）。遷移で中断されないよう keepalive を付ける */
function browserPost(win) {
  return (event, source) => {
    try {
      win.fetch(FUNNEL_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        // source は**そのまま送るだけ**。採否はサーバーの allow-list が決める
        body: JSON.stringify(source ? { event, source } : { event }),
      }).catch(() => {});
    } catch { /* fetch が無い環境では黙って何もしない */ }
  };
}

/** 既定の可視判定（IntersectionObserver）。無い環境では即座に見えたとみなす */
function browserObserve(win) {
  return (el, onVisible) => {
    if (typeof win.IntersectionObserver !== 'function') { onVisible(); return; }
    const io = new win.IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { io.disconnect(); onVisible(); return; }
      }
    }, { threshold: VIEW_RATIO });
    io.observe(el);
  };
}

/**
 * キューを引き取り、以後の push を即時送信にする。
 * 何度呼んでも 1 回しか効かない。
 *
 * @returns {ReturnType<typeof createFunnelClient>|null}
 */
export function installPlusFunnel(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w || w[FUNNEL_INSTALLED_KEY]) return null;
  w[FUNNEL_INSTALLED_KEY] = true;

  const client = createFunnelClient({ post: browserPost(w), observe: browserObserve(w) });
  const pending = Array.isArray(w[FUNNEL_QUEUE_KEY]) ? w[FUNNEL_QUEUE_KEY].slice() : [];
  // 以後の push は即時処理。**配列を差し替えるので inline 側の `|| []` は再作成しない**
  w[FUNNEL_QUEUE_KEY] = { push: (item) => { client.accept(item); return 0; } };
  for (const item of pending) client.accept(item);
  return client;
}

/**
 * inline script / 他モジュールから 1 件積む安全な入口。
 * install 前でも後でも同じように書ける。
 */
export function pushPlusFunnelEvent(win, item) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w) return;
  if (!w[FUNNEL_QUEUE_KEY]) w[FUNNEL_QUEUE_KEY] = [];
  try { w[FUNNEL_QUEUE_KEY].push(item); } catch { /* 差し替え中は捨てる */ }
}
