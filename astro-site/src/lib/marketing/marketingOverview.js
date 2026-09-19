/**
 * marketingOverview.js — 管理画面に出す**数だけ**を組む（I/O は注入）
 *
 * ## なぜ lib なのか
 *
 * 同じ数を 2 か所（移行用の管理 API と、マーケ画面が叩く API）から返す。
 * 画面側は**送信基盤の名前が入った関数を叩けない**（`stagedReleaseGuard` が
 * 管理画面にメール基盤の固有名詞を持ち込ませない）ので、画面は `admin-marketing` を叩く。
 * 数の作り方が 2 つに割れないよう、**判定はここ 1 つ**に置く。
 *
 * ⚠️ 読み取りだけ。**アドレスは 1 件も返さない**（件数と日時だけ）。
 */

import { listNameFor } from './sendgridAutomationPlan.js';
import { CONTINUATION_LIST_NAME } from './sendgridContinuation.js';

export const ACTIVE_INDEX_KEY = 'ak:prospect:index:active';
export const ENGAGED_INDEX_KEY = 'ak:prospect:index:engaged';
export const BLOCKED_INDEX_KEY = 'ak:prospect:index:blocked';
export const WATCH_STATE_KEY = 'ak:mkt:selection-watch:v1';
/**
 * ⚠️ `/v3/marketing/stats/singlesends` の `page_size` は **1〜50**。
 *    100 を渡すと 400 になる（2026-09-19 に本番で踏み、点検が丸ごと落ちた）。
 */
export const STATS_PAGE_SIZE = 50;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {{
 *   lists: Array<{name:string, contactCount:number}>,
 *   singleSends: Array<object>,
 *   stats: Array<object>,
 *   akActive: number|null, akEngaged: number|null,
 *   watchState: object|null,
 *   weeklyEnabled: boolean,
 * }} input
 */
export function buildMarketingOverview({
  lists = [], singleSends = [], stats = [],
  akActive = null, akEngaged = null, akBlocked = null,
  watchState = null, weeklyEnabled = false,
  /** 取れなかった素材（**0 と区別する**。空欄や 0 で流さない） */
  unavailable = [],
} = {}) {
  const byName = new Map(lists.map((l) => [l.name, l.contactCount]));
  const selectionLists = [1, 2, 3].map((n) => ({
    list: listNameFor(n), 人数: byName.has(listNameFor(n)) ? byName.get(listNameFor(n)) : null,
  }));
  const statById = new Map(stats.map((x) => [String(x.id), x.stats || {}]));
  const rows = singleSends.map((x) => {
    const st = statById.get(String(x.id)) || {};
    return {
      name: String(x.name || ''),
      status: String(x.status || ''),
      send_at: x.send_at || null,
      requests: num(st.requests),
      delivered: num(st.delivered),
      opens: num(st.unique_opens),
      bounces: num(st.bounces),
      unsubscribes: num(st.unsubscribes),
    };
  });
  const selectionSends = rows.filter((x) => /^AK Prospect Selection /.test(x.name));
  const weeklySends = rows.filter((x) => /^AK Weekly /.test(x.name));
  const sum = (list, key) => list.reduce((a, r) => a + num(r[key]), 0);
  const nextOf = (list) => list
    .filter((x) => x.status === 'scheduled' && x.send_at)
    .map((x) => x.send_at).sort()[0] || null;

  const w = watchState && typeof watchState === 'object' ? watchState : null;
  /**
   * ⚠️ **読めなかったものを 0 で出さない。**
   *    実績が取れていないのに 0 と書くと「送っていない」と読まれる。
   */
  const statsUnavailable = unavailable.includes('stats');
  const metrics = (list) => (statsUnavailable ? null : {
    requests: sum(list, 'requests'),
    delivered: sum(list, 'delivered'),
    開封: sum(list, 'opens'),
    bounce: sum(list, 'bounces'),
    配信停止: sum(list, 'unsubscribes'),
  });

  return {
    取得できなかったもの: unavailable,
    選別: {
      list別: selectionLists,
      list合計: selectionLists.reduce((a, r) => a + (r.人数 || 0), 0),
      予約: selectionSends.filter((x) => x.status === 'scheduled').length,
      送信済み: selectionSends.filter((x) => x.status === 'triggered').length,
      実績: metrics(selectionSends),
      次の配信: nextOf(selectionSends),
    },
    反応: {
      AK送信候補: akActive,
      AK反応済み: akEngaged,
      /** 配信停止・bounce・苦情・打ち切り（**もう送らない**人） */
      AK抑止: akBlocked,
      継続list: byName.has(CONTINUATION_LIST_NAME) ? byName.get(CONTINUATION_LIST_NAME) : null,
      継続list名: CONTINUATION_LIST_NAME,
    },
    自動点検: w ? {
      /** **走り出した**時刻。ここだけ入って「最終実行」が古いなら、途中で落ちている */
      最終起動: w.lastStartedAtMs ? new Date(w.lastStartedAtMs).toISOString() : null,
      最終実行: w.lastCheckedAtMs ? new Date(w.lastCheckedAtMs).toISOString() : null,
      最後に知らせた: w.lastNotifiedAtMs ? new Date(w.lastNotifiedAtMs).toISOString() : null,
      不整合: Number.isFinite(w.lastMismatch) ? w.lastMismatch : null,
    } : null,
    週次: {
      有効: weeklyEnabled === true,
      予約: weeklySends.filter((x) => x.status === 'scheduled').length,
      送信済み: weeklySends.filter((x) => x.status === 'triggered').length,
      次の配信: nextOf(weeklySends),
      実績: statsUnavailable ? null : {
        delivered: sum(weeklySends, 'delivered'),
        開封: sum(weeklySends, 'opens'),
        配信停止: sum(weeklySends, 'unsubscribes'),
      },
    },
  };
}

/**
 * 実データを集めて組む（I/O はここだけ。呼び出し側は 1 行で使える）。
 * @param {{apiKey:string, redisCmd:Function, env?:object, fetchImpl?:Function}} deps
 */
export async function collectMarketingOverview({ apiKey, redisCmd, env = process.env, fetchImpl } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const get = async (path) => {
    const r = await doFetch(`https://api.sendgrid.com${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) throw new Error(`sendgrid_http_${r.status}`);
    return r.json();
  };

  /**
   * ⚠️ 取れなかったものは**名前を控える**。黙って空にすると 0 と見分けが付かない。
   */
  const unavailable = [];
  const safe = async (name, path) => {
    try { return await get(path); } catch { unavailable.push(name); return {}; }
  };
  const [listsRaw, sendsRaw, statsRaw] = await Promise.all([
    safe('lists', '/v3/marketing/lists?page_size=100'),
    safe('singleSends', '/v3/marketing/singlesends?page_size=100'),
    safe('stats', `/v3/marketing/stats/singlesends?page_size=${STATS_PAGE_SIZE}`),
  ]);

  let akActive = null;
  let akEngaged = null;
  let akBlocked = null;
  let watchState = null;
  if (typeof redisCmd === 'function') {
    try {
      akActive = num(await redisCmd(['SCARD', ACTIVE_INDEX_KEY]));
      akEngaged = num(await redisCmd(['SCARD', ENGAGED_INDEX_KEY]));
      akBlocked = num(await redisCmd(['SCARD', BLOCKED_INDEX_KEY]));
      const raw = await redisCmd(['GET', WATCH_STATE_KEY]);
      if (raw) watchState = JSON.parse(raw);
    } catch { /* 読めなければ null のまま（**推測しない**） */ }
  }

  return buildMarketingOverview({
    lists: ((listsRaw && listsRaw.result) || []).map((l) => ({
      name: String(l.name || ''), contactCount: num(l.contact_count),
    })),
    singleSends: (sendsRaw && sendsRaw.result) || [],
    stats: (statsRaw && statsRaw.results) || [],
    akActive,
    akEngaged,
    akBlocked,
    watchState,
    weeklyEnabled: String((env && env.SENDGRID_WEEKLY_ENABLED) || '').trim() === 'true',
    unavailable,
  });
}

export default collectMarketingOverview;
