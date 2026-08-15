/**
 * rolloutMetrics.js — 運用画面の数字を**増分で**持つ（Redis が正本 / I/O は cmd に委譲）
 *
 * ── 解決する問題（2026-08-15 実測）────────────────────────────
 * `action=rollout` が Customers 14,489 件と配信履歴を**リクエストのたびに**読む設計だと、
 * 取得だけで **約 156 秒**かかる。Netlify の同期 Function は 26 秒で kill されるので、
 * ダッシュボードは**原理的に開かない**。
 * 24 Step まで伸ばせば配信行は 14,489 × 24 ≒ **35 万行**になり、さらに悪化する。
 *
 * ── 方針: source-of-truth と集計を分ける ──────────────────────
 *
 * | | 正本 | 集計（このモジュール） |
 * |---|---|---|
 * | 何が入るか | Customers / CampaignDeliveries / ScheduledEmails | 件数だけ |
 * | 誰が書くか | 付与・キュー登録・送信の各経路 | **同じ経路が 1 回だけ加算** |
 * | 読むとき | 個別の照合（名指し） | ダッシュボード（**O(1)**） |
 * | ズレたら | 正本が勝つ | `reconcile` で作り直す |
 *
 * ダッシュボードは集計だけを読む（**数回の Redis GET**）。
 * 正本を読み直さないので、母集団が何万件でも所要は変わらない。
 *
 * ── 欠けているときは「部分」と言う ────────────────────────────
 * 集計が無い / 壊れている / 版が古いときは **`partial: true`** を返し、
 * 数字を出さない。**「0 件」と表示しない**（0 と未計測は別物）。
 *
 * ⚠️ 鍵にも値にも PII を入れない。入るのは campaignId と件数だけ。
 */

/** 集計の鍵空間（状態・排他とは分ける） */
export const METRICS_ROOT = 'ak:marketing-metrics:';

export const metricsKey = Object.freeze({
  /** キャンペーン全体の集計（1 キー） */
  totals: (campaignId) => `${METRICS_ROOT}totals:${campaignId}`,
  /** Step 別の集計（1 キー。Step 数が増えても JSON 1 つ） */
  steps: (campaignId) => `${METRICS_ROOT}steps:${campaignId}`,
});

/** 集計の形式版。**形を変えたら上げる**（古い形は partial 扱いにする） */
export const METRICS_SCHEMA_VERSION = 1;

export const METRICS_FAIL = Object.freeze({
  UNREACHABLE: 'unreachable',
  UNKNOWN_RESULT: 'unknown_result',
  OUT_OF_NAMESPACE: 'out_of_namespace',
  DATA_CORRUPT: 'data_corrupt',
  BAD_CAMPAIGN_ID: 'bad_campaign_id',
  SCHEMA_MISMATCH: 'schema_mismatch',
});

export class MetricsError extends Error {
  constructor(code, detail) {
    super(`rollout_metrics:${code}`);
    this.name = 'MetricsError';
    this.code = code;
    this.detail = detail || null;
  }
}

export function isSafeCampaignId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);
}

/** 集計に持つ数（**件数だけ**。率はここで作らない） */
export function emptyTotals() {
  return {
    schema: METRICS_SCHEMA_VERSION,
    /** 付与した人数（＝シーケンスに入った人数） */
    granted: 0,
    /** 1 通も送っていない人数 */
    notStarted: 0,
    /** 送信中 */
    inProgress: 0,
    /** 購入して止めた人数 */
    purchased: 0,
    /** 明示的な拒否・到達不能で止めた人数 */
    stopped: 0,
    /** 最大回数まで送り終えた人数 */
    completed: 0,
    /** 停止理由の内訳 */
    byStopReason: {},
    updatedAtMs: null,
  };
}

/** Step 別（送信・失敗・開封・クリック）。**率は画面側で作る** */
export function emptySteps() {
  return { schema: METRICS_SCHEMA_VERSION, steps: {}, updatedAtMs: null };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 加算する差分の形（**負の値は受け付けない**。取り消しは reconcile で作り直す） */
export function normalizeDelta(delta) {
  const d = delta && typeof delta === 'object' ? delta : {};
  const pick = (k) => Math.max(0, Math.floor(num(d[k])));
  return {
    granted: pick('granted'),
    notStarted: pick('notStarted'),
    inProgress: pick('inProgress'),
    purchased: pick('purchased'),
    stopped: pick('stopped'),
    completed: pick('completed'),
    byStopReason: d.byStopReason && typeof d.byStopReason === 'object' ? d.byStopReason : {},
  };
}

/**
 * ⚠️ **加算は Lua で atomic に行う。** 「読んで足して書く」だと、
 * 付与・送信・反応の各経路が同時に走ったときに数が落ちる。
 *
 *   KEYS[1] = totals キー / ARGV[1] = 差分 JSON / ARGV[2] = 形式版 / ARGV[3] = 時刻
 */
const BUMP_TOTALS_LUA = `
local cur = redis.call('GET', KEYS[1])
local t
if cur then t = cjson.decode(cur) else t = {} end
local d = cjson.decode(ARGV[1])
for _, k in ipairs({'granted','notStarted','inProgress','purchased','stopped','completed'}) do
  t[k] = (tonumber(t[k]) or 0) + (tonumber(d[k]) or 0)
end
if d.byStopReason then
  if not t.byStopReason then t.byStopReason = {} end
  for k, v in pairs(d.byStopReason) do
    t.byStopReason[k] = (tonumber(t.byStopReason[k]) or 0) + (tonumber(v) or 0)
  end
end
t.schema = tonumber(ARGV[2])
t.updatedAtMs = tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(t))
return 'OK'
`;

/**
 *   KEYS[1] = steps キー / ARGV[1] = `{"1":{"sent":3,"failed":0},...}` / ARGV[2] 版 / ARGV[3] 時刻
 */
const BUMP_STEPS_LUA = `
local cur = redis.call('GET', KEYS[1])
local t
if cur then t = cjson.decode(cur) else t = {} end
if not t.steps then t.steps = {} end
local d = cjson.decode(ARGV[1])
for step, m in pairs(d) do
  if not t.steps[step] then t.steps[step] = {} end
  for _, k in ipairs({'sent','failed','opened','clicked','queued'}) do
    t.steps[step][k] = (tonumber(t.steps[step][k]) or 0) + (tonumber(m[k]) or 0)
  end
end
t.schema = tonumber(ARGV[2])
t.updatedAtMs = tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(t))
return 'OK'
`;

export function createRolloutMetrics(deps = {}) {
  const cmd = deps.cmd;
  if (typeof cmd !== 'function') throw new Error('createRolloutMetrics: cmd が必要です');

  const assertKey = (key) => {
    const k = String(key ?? '');
    if (!k.startsWith(METRICS_ROOT)) throw new MetricsError(METRICS_FAIL.OUT_OF_NAMESPACE);
    return k;
  };

  const call = async (args) => {
    const op = String(args[0] || '').toUpperCase();
    if (['GET', 'SET', 'DEL'].includes(op)) assertKey(args[1]);
    if (op === 'EVAL') {
      const n = Number(args[2]);
      for (const k of args.slice(3, 3 + (Number.isFinite(n) ? n : 0))) assertKey(k);
    }
    let res;
    try { res = await cmd(args); } catch { throw new MetricsError(METRICS_FAIL.UNREACHABLE, op); }
    if (res === undefined) throw new MetricsError(METRICS_FAIL.UNKNOWN_RESULT, op);
    return res;
  };

  const guard = (campaignId) => {
    if (!isSafeCampaignId(campaignId)) throw new MetricsError(METRICS_FAIL.BAD_CAMPAIGN_ID);
    return campaignId;
  };

  const parse = (raw, fallback) => {
    if (raw === null) return null;
    let v;
    try { v = JSON.parse(raw); } catch { throw new MetricsError(METRICS_FAIL.DATA_CORRUPT); }
    if (Number(v && v.schema) !== METRICS_SCHEMA_VERSION) {
      throw new MetricsError(METRICS_FAIL.SCHEMA_MISMATCH, String(v && v.schema));
    }
    return { ...fallback, ...v };
  };

  return {
    assertKey,

    /**
     * ダッシュボード用の読み取り。**Redis GET 2 回だけ**。
     * 集計が無い / 壊れている / 版違いなら `partial: true`（数字を出さない）。
     */
    async read(campaignId) {
      guard(campaignId);
      try {
        const [t, s] = await Promise.all([
          call(['GET', metricsKey.totals(campaignId)]),
          call(['GET', metricsKey.steps(campaignId)]),
        ]);
        const totals = parse(t, emptyTotals());
        const steps = parse(s, emptySteps());
        // ⚠️ 「不明」と「まだ 0 件」を分ける。
        //    片方だけ書かれている状態は正常（付与はしたが 1 通も送っていない等）。
        //    **どちらも無いときだけ**「まだ計測を始めていない」として partial にする。
        if (!totals && !steps) {
          return { partial: true, reason: 'not_initialized', totals: null, steps: null };
        }
        return {
          partial: false, reason: null,
          totals: totals || emptyTotals(),
          steps: steps || emptySteps(),
        };
      } catch (e) {
        return {
          partial: true,
          reason: (e instanceof MetricsError && e.code) || METRICS_FAIL.UNREACHABLE,
          totals: null, steps: null,
        };
      }
    },

    /** 付与・停止などの人数を**加算**する（atomic） */
    async bumpTotals({ campaignId, delta, nowMs }) {
      guard(campaignId);
      const d = normalizeDelta(delta);
      await call([
        'EVAL', BUMP_TOTALS_LUA, '1', metricsKey.totals(campaignId),
        JSON.stringify(d), String(METRICS_SCHEMA_VERSION), String(Number(nowMs) || 0),
      ]);
      return { ok: true };
    },

    /** Step 別の送信・失敗・反応を**加算**する（atomic） */
    async bumpSteps({ campaignId, delta, nowMs }) {
      guard(campaignId);
      const clean = {};
      for (const [step, m] of Object.entries(delta && typeof delta === 'object' ? delta : {})) {
        if (!/^\d+$/.test(String(step))) continue;
        clean[String(step)] = {
          sent: Math.max(0, Math.floor(num(m && m.sent))),
          failed: Math.max(0, Math.floor(num(m && m.failed))),
          opened: Math.max(0, Math.floor(num(m && m.opened))),
          clicked: Math.max(0, Math.floor(num(m && m.clicked))),
          queued: Math.max(0, Math.floor(num(m && m.queued))),
        };
      }
      if (Object.keys(clean).length === 0) return { ok: true, skipped: true };
      await call([
        'EVAL', BUMP_STEPS_LUA, '1', metricsKey.steps(campaignId),
        JSON.stringify(clean), String(METRICS_SCHEMA_VERSION), String(Number(nowMs) || 0),
      ]);
      return { ok: true };
    },

    /**
     * 正本から作り直す（**ズレたときの復旧口**）。
     * 呼び出し側が正本を読んで集計を渡す。ここでは上書きするだけ。
     */
    async reconcile({ campaignId, totals, steps, nowMs }) {
      guard(campaignId);
      const t = { ...emptyTotals(), ...(totals || {}), schema: METRICS_SCHEMA_VERSION, updatedAtMs: Number(nowMs) || null };
      const s = { ...emptySteps(), ...(steps || {}), schema: METRICS_SCHEMA_VERSION, updatedAtMs: Number(nowMs) || null };
      await call(['SET', metricsKey.totals(campaignId), JSON.stringify(t)]);
      await call(['SET', metricsKey.steps(campaignId), JSON.stringify(s)]);
      return { ok: true, totals: t, steps: s };
    },
  };
}

/**
 * ダッシュボードが 1 回の読み取りで済む I/O 回数の見積り。
 * **母集団の大きさに依存しない**ことをテストで固定する。
 */
export function estimateDashboardIo({ cohortSize, stepCount }) {
  return {
    // 集計は 2 キーだけ。cohort / step が増えても変わらない
    redisGets: 2,
    airtablePages: 0,
    cohortSize: Number(cohortSize) || 0,
    stepCount: Number(stepCount) || 0,
  };
}

export default createRolloutMetrics;
