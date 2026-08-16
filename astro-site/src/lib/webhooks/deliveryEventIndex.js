/**
 * deliveryEventIndex.js — **1 通ごと**の配信結果を DeliveryKey で引ける索引（Redis）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 「この人はこの touch を開いたか」を判断するには、**その 1 通**の結果が要る。
 * いま本番にあるのは
 *   - Blob の生ログ（正本・監査用。**全件走査は高い**）
 *   - 受信者ごとの反応集計（`engagementSignalStore`。**どの通かは分からない**）
 * だけで、後者から「最新の開封時刻」を使うと、**古いメールを後から開いた**ときに
 * 別の touch を「開封済み」と誤って帰属してしまう。
 *
 * そこで **DeliveryKey（campaign × version × step × 受信者の sha256）完全一致**で
 * 引ける索引を Redis に置く。管理画面も cron も、必要な鍵だけを bounded read する。
 *
 * ── 置くもの（最小）──────────────────────────────────────────
 *   `d`  … delivered の時刻（ms）
 *   `o`  … 最初の open の時刻（ms）
 *   `ol` … 最後の open の時刻（ms）
 *   `oc` … open の回数
 *   `v`  … スキーマ版
 *
 * ⚠️ **click は持たない**。provider 側で click tracking が OFF のため
 *    （有効にするとアカウント全体に掛かり、マジックリンクが壊れる）。
 *    「押していない」ではなく「観測していない」なので、値を作らない。
 * ⚠️ bounce / spam / unsubscribe は**既存の停止経路が正本**（`EmailBlacklist` /
 *    `Customers`）。ここへ写して別の正本を作らない。
 *
 * ── 性質 ──────────────────────────────────────────────────────
 * - **PII を入れない**（鍵は sha256 の DeliveryKey。メールアドレスは保存しない）
 * - **冪等**（provider の再送で二重に数えない。時刻は「より古い delivered」
 *   「より古い first open」を残し、open 回数は同じイベントでは増やさない）
 * - **再構築できる**（正本は Blob の生ログ。索引が消えても作り直せる）
 * - 書き込み失敗で webhook を落とさない（呼び出し側が握る）
 */

/** 鍵の名前空間（他の用途と混ぜない） */
export const DELIVERY_EVENT_ROOT = 'ak:delivery-events:';

/** スキーマ版。**形を変えたら上げる**（読み側は版違いを unknown として扱う） */
export const DELIVERY_EVENT_SCHEMA = 1;

/** 索引が扱うイベント種別（これ以外は無視する） */
export const INDEXED_EVENTS = Object.freeze(['delivered', 'open']);

/** DeliveryKey の形（`computeCampaignDeliveryKey` = sha256 hex 64） */
const DELIVERY_KEY = /^[a-f0-9]{64}$/;

/** 1 回の読み取りで許す鍵の数（**全件走査をさせない**） */
export const MAX_READ_KEYS = 500;

export const INDEX_FAIL = Object.freeze({
  BAD_KEY: 'bad_delivery_key',
  UNREACHABLE: 'redis_unreachable',
  TOO_MANY_KEYS: 'too_many_keys',
});

export function isSafeDeliveryKey(key) {
  return DELIVERY_KEY.test(String(key ?? ''));
}

export function deliveryEventKey(deliveryKey) {
  return `${DELIVERY_EVENT_ROOT}${deliveryKey}`;
}

/**
 * 数として読む。**`null` / `undefined` / 空文字は「不明」**（0 にしない）。
 * ⚠️ `Number(null) === 0` なので、素の `Number()` だと「記録が無い」が
 *    「0 ミリ秒に配信された」になり、未計測が計測済みに化ける。
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * イベントの列から「鍵ごとに何を書くか」を作る（純粋）。
 *
 * ⚠️ **resolved なイベントだけ**を渡すこと（DeliveryKey が完全一致したもの）。
 *    ここでは推測しない。鍵が無い / 形が違うイベントは黙って捨てる。
 *
 * @param {Array<{type: string, atMs: number, customArgs?: {deliveryKey?: string},
 *                deliveryKey?: string, providerEventId?: string}>} events
 * @returns {{updates: Map<string, {deliveredAtMs: number|null, firstOpenAtMs: number|null,
 *            lastOpenAtMs: number|null, openEventIds: string[]}>, skipped: object}}
 */
export function planIndexUpdates(events) {
  const updates = new Map();
  const skipped = { noKey: 0, badKey: 0, otherType: 0, noTime: 0 };
  for (const e of Array.isArray(events) ? events : []) {
    const type = String((e && e.type) || '').toLowerCase();
    if (!INDEXED_EVENTS.includes(type)) { skipped.otherType += 1; continue; }
    const key = String((e && (e.deliveryKey || (e.customArgs || {}).deliveryKey)) || '');
    if (!key) { skipped.noKey += 1; continue; }
    if (!isSafeDeliveryKey(key)) { skipped.badKey += 1; continue; }
    const atMs = num(e.atMs);
    if (atMs === null) { skipped.noTime += 1; continue; }

    const cur = updates.get(key) || {
      deliveredAtMs: null, firstOpenAtMs: null, lastOpenAtMs: null, openEventIds: [],
    };
    if (type === 'delivered') {
      // 同じ通の delivered が複数来たら**より早い方**を残す（再送で上書きしない）
      cur.deliveredAtMs = cur.deliveredAtMs === null ? atMs : Math.min(cur.deliveredAtMs, atMs);
    } else {
      cur.firstOpenAtMs = cur.firstOpenAtMs === null ? atMs : Math.min(cur.firstOpenAtMs, atMs);
      cur.lastOpenAtMs = cur.lastOpenAtMs === null ? atMs : Math.max(cur.lastOpenAtMs, atMs);
      const id = String((e && e.providerEventId) || '');
      if (id && !cur.openEventIds.includes(id)) cur.openEventIds.push(id);
    }
    updates.set(key, cur);
  }
  return { updates, skipped };
}

/**
 * 冪等な畳み込み（Lua）。
 *
 * - `d`（delivered）は**まだ無いか、より早いときだけ**入れる
 * - `o`（first open）も同じ。`ol`（last open）は**より遅いときだけ**入れる
 * - `oc`（open 回数）は **provider の event id が未登録のときだけ** +1
 *   （同じイベントの再送で二重に数えない）
 */
const FOLD_LUA = `
local key = KEYS[1]
local schema = ARGV[1]
local delivered = tonumber(ARGV[2])
local firstOpen = tonumber(ARGV[3])
local lastOpen = tonumber(ARGV[4])
local seenPrefix = 'seen:'
redis.call('HSET', key, 'v', schema)
if delivered and delivered > 0 then
  local cur = tonumber(redis.call('HGET', key, 'd'))
  if (not cur) or delivered < cur then redis.call('HSET', key, 'd', delivered) end
end
if firstOpen and firstOpen > 0 then
  local cur = tonumber(redis.call('HGET', key, 'o'))
  if (not cur) or firstOpen < cur then redis.call('HSET', key, 'o', firstOpen) end
end
if lastOpen and lastOpen > 0 then
  local cur = tonumber(redis.call('HGET', key, 'ol'))
  if (not cur) or lastOpen > cur then redis.call('HSET', key, 'ol', lastOpen) end
end
for i = 5, #ARGV do
  local id = ARGV[i]
  if id ~= '' then
    local field = seenPrefix .. id
    if redis.call('HSETNX', key, field, '1') == 1 then
      redis.call('HINCRBY', key, 'oc', 1)
    end
  end
end
return 'OK'
`;

/**
 * 索引の読み書き。I/O（Redis コマンド）は注入する。
 *
 * @param {{cmd: (args: string[]) => Promise<any>}} deps
 */
export function createDeliveryEventIndex(deps = {}) {
  const cmd = deps.cmd;
  if (typeof cmd !== 'function') throw new Error('createDeliveryEventIndex: cmd が必要です');

  const assertKey = (k) => {
    if (!String(k).startsWith(DELIVERY_EVENT_ROOT)) throw new Error('delivery_event_index:out_of_namespace');
    return k;
  };

  return {
    /**
     * resolved なイベントを索引へ畳む。**失敗しても例外を投げない**
     * （webhook を落とさない。取りこぼしは Blob から作り直せる）。
     */
    async fold({ events, nowMs }) {
      const { updates, skipped } = planIndexUpdates(events);
      const out = {
        schema: DELIVERY_EVENT_SCHEMA,
        keys: updates.size, written: 0, failed: 0, skipped, nowMs: num(nowMs),
      };
      for (const [key, u] of updates) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await cmd([
            'EVAL', FOLD_LUA, '1', assertKey(deliveryEventKey(key)),
            String(DELIVERY_EVENT_SCHEMA),
            String(u.deliveredAtMs ?? 0),
            String(u.firstOpenAtMs ?? 0),
            String(u.lastOpenAtMs ?? 0),
            ...u.openEventIds.slice(0, 20),
          ]);
          out.written += 1;
        } catch {
          out.failed += 1;   // 理由は載せない（PII / 接続情報の混入を避ける）
        }
      }
      return out;
    },

    /**
     * 指定した鍵だけを読む（**bounded**。全件走査はしない）。
     *
     * @returns {{ok: boolean, reason?: string, byKey: Map<string, object>}}
     *   読めなかった場合は `ok: false`。**呼び出し側は「未計測」として扱うこと**
     *   （0 件として扱わない）。
     */
    async read(deliveryKeys) {
      const keys = (Array.isArray(deliveryKeys) ? deliveryKeys : []).filter(isSafeDeliveryKey);
      if (keys.length > MAX_READ_KEYS) {
        return { ok: false, reason: INDEX_FAIL.TOO_MANY_KEYS, byKey: new Map() };
      }
      const byKey = new Map();
      for (const k of keys) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await cmd(['HMGET', assertKey(deliveryEventKey(k)), 'v', 'd', 'o', 'ol', 'oc']);
          const [v, d, o, ol, oc] = Array.isArray(res) ? res : [];
          const schema = num(v);
          // 版が違う索引は**読まない**（形が変わっている可能性がある）
          if (schema !== DELIVERY_EVENT_SCHEMA) continue;
          byKey.set(k, {
            deliveredAtMs: num(d),
            firstOpenAtMs: num(o),
            lastOpenAtMs: num(ol),
            openCount: num(oc) ?? 0,
          });
        } catch {
          // 1 件でも読めなければ「全体が読めない」として扱う（部分結果で判断させない）
          return { ok: false, reason: INDEX_FAIL.UNREACHABLE, byKey: new Map() };
        }
      }
      return { ok: true, byKey };
    },
  };
}

/**
 * 索引 1 件を **sequencePolicy の履歴 1 行**へ変換する（純粋）。
 *
 * | 索引の状態 | 返す行 |
 * |---|---|
 * | delivered あり + open あり | `measured: true` / `opened: true` |
 * | delivered あり + open なし | `measured: true` / `opened: false` |
 * | delivered を確認できない | `measured: false`（**無反応として数えない**） |
 * | 索引そのものが読めない | `measured: false` |
 *
 * ⚠️ **click は含めない**（provider 側 OFF。false と捏造しない）。
 * ⚠️ 「受信者の最新 open 時刻」から推測しない。**この鍵の記録だけ**を見る。
 */
export function toHistoryRow({ deliveryKey, entry, sentAtMs, step }) {
  const e = entry || null;
  const deliveredAtMs = e ? num(e.deliveredAtMs) : null;
  const openedAtMs = e ? num(e.firstOpenAtMs) : null;
  const measured = deliveredAtMs !== null;
  return {
    deliveryKey: String(deliveryKey || ''),
    step: num(step),
    sentAtMs: num(sentAtMs),
    measured,
    // 観測できていないときは **true/false を作らない**（unknown のまま）
    ...(measured ? { opened: openedAtMs !== null } : {}),
    deliveredAtMs,
    openedAtMs,
    openCount: e ? (num(e.openCount) ?? 0) : 0,
  };
}

export default createDeliveryEventIndex;
