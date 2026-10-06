/**
 * airtableCallMeter.js — Airtable API の呼び出し回数を「どの処理が・何回」で数える（2026-10-05）
 *
 * ## なぜ
 *
 * Team プランの API 上限は月 100,000 回。2026-10 に 247,168 回まで超過したが、
 * どの処理が何回呼んでいるかの実測が無く、推測で削っては再発していた（2026-08 にも 8,372,540 回）。
 * 削減は**実測の大きい順**に行い、削減後も毎日数えて超過を早く検知する。
 *
 * ## 何をするか
 *
 * `installAirtableCallMeter()` を各 Function / SSR の入口で 1 回呼ぶと、`globalThis.fetch` を包み、
 * `api.airtable.com` への呼び出しだけを Redis の日別 HASH に数える。
 *
 *   ak:ops:airtable-calls:v1:{JST 日付}  field = 呼び出し元（Function 名）  value = 回数
 *
 * - 本体の fetch と**並行して**数える（応答を待たせない）。数える側の失敗は握りつぶす（本体は止めない）。
 * - airtable SDK（node-fetch を内部で使う）経由の呼び出しは包めないので、
 *   `countAirtableCalls(source, n)` で明示的に数える。
 * - URL・本文・レコード ID は記録しない（回数だけ）。
 */

export const METER_KEY_PREFIX = 'ak:ops:airtable-calls:v1:';
const METER_TTL_SEC = 120 * 86400;
const INSTALLED = Symbol.for('ak.airtableCallMeter.installed');

export function jstDay(nowMs = Date.now()) {
  return new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);
}

export function isAirtableApiUrl(input) {
  try {
    const url = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
    return /^https:\/\/api\.airtable\.com\//.test(String(url));
  } catch {
    return false;
  }
}

/** Function 名（Netlify / Lambda の環境変数）。分からなければ fallback */
export function resolveSource(env = process.env, fallback = 'unknown') {
  const raw = String(env.AWS_LAMBDA_FUNCTION_NAME || env.SITE_FUNCTION_NAME || '').trim();
  if (!raw) return fallback;
  // Netlify は "{site-id}-{function}" 等の接頭辞を付けることがある。末尾の関数名だけを残す
  const m = /([a-z0-9][a-z0-9-]*)$/i.exec(raw);
  return (m ? m[1] : raw).slice(-60);
}

function redisConfig(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

/**
 * 回数を足す（失敗しても例外を投げない）。
 * @param {string} source
 * @param {number} n
 * @param {{ env?: object, fetchImpl?: Function, nowMs?: number }} [opts]
 */
export async function countAirtableCalls(source, n = 1, opts = {}) {
  const env = opts.env || process.env;
  const cfg = redisConfig(env);
  const doFetch = opts.fetchImpl || globalThis.__akOriginalFetch || globalThis.fetch;
  if (!cfg || typeof doFetch !== 'function' || !(n > 0)) return false;
  const key = `${METER_KEY_PREFIX}${jstDay(opts.nowMs)}`;
  try {
    const res = await doFetch(`${cfg.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['HINCRBY', key, String(source || 'unknown'), String(n)],
        ['EXPIRE', key, String(METER_TTL_SEC)],
      ]),
      // ⚠️ 素の `AbortSignal` と書かない（必ず globalThis 経由）。esbuild は同梱した
      // abort-controller の `class AbortSignal` を `AbortSignal2` に改名してしまい、
      // airtable SDK 内の node-fetch v2 が constructor.name で弾いて全 Airtable 呼び出しが落ちる
      // （2026-10-05〜06 の全会員ログイン不能。airtableAbortSignalBundle.guard.test.mjs で固定）。
      signal: globalThis.AbortSignal?.timeout ? globalThis.AbortSignal.timeout(800) : undefined,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * globalThis.fetch を包む（同じプロセスで 2 回呼んでも 1 回だけ）。
 * @param {{ source?: string, env?: object }} [opts]
 */
export function installAirtableCallMeter(opts = {}) {
  if (typeof globalThis.fetch !== 'function' || globalThis[INSTALLED]) return false;
  const env = opts.env || process.env;
  if (!redisConfig(env)) return false;
  const original = globalThis.fetch;
  globalThis.__akOriginalFetch = original;
  const source = opts.source || resolveSource(env);
  const wrapped = async function meteredFetch(input, init) {
    if (!isAirtableApiUrl(input)) return original(input, init);
    const counting = countAirtableCalls(source, 1, { env, fetchImpl: original }).catch(() => false);
    try {
      return await original(input, init);
    } finally {
      await counting;
    }
  };
  globalThis.fetch = wrapped;
  globalThis[INSTALLED] = true;
  return true;
}

/** 日別の集計を読む（管理用） */
export async function readAirtableCallDays({ days = 31, env = process.env, nowMs = Date.now(), fetchImpl } = {}) {
  const cfg = redisConfig(env);
  const doFetch = fetchImpl || globalThis.__akOriginalFetch || globalThis.fetch;
  if (!cfg) return { ok: false, reason: 'redis_unavailable', days: [] };
  const keys = [];
  for (let i = 0; i < days; i += 1) keys.push(jstDay(nowMs - i * 86400000));
  const res = await doFetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(keys.map((d) => ['HGETALL', `${METER_KEY_PREFIX}${d}`])),
  });
  if (!res.ok) return { ok: false, reason: `redis_${res.status}`, days: [] };
  const rows = await res.json();
  const out = keys.map((day, i) => {
    const raw = rows[i]?.result || [];
    const bySource = {};
    for (let j = 0; j + 1 < raw.length; j += 2) bySource[raw[j]] = Number(raw[j + 1]) || 0;
    const total = Object.values(bySource).reduce((a, b) => a + b, 0);
    return { day, total, bySource };
  });
  return { ok: true, days: out };
}

/**
 * 月の見込み（計測できた日の平均 × その月の日数）。計測日が 0 なら null。
 */
export function projectMonthly(days, { monthDays = 30 } = {}) {
  const measured = (days || []).filter((d) => d.total > 0);
  if (measured.length === 0) return null;
  const avg = measured.reduce((a, d) => a + d.total, 0) / measured.length;
  return Math.round(avg * monthDays);
}
