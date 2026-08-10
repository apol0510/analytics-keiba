/**
 * 「二重送信の判定に何を信じるか」の単一源。
 *
 * Airtable のレコード上限を回避するため、`CampaignDeliveries` の役割のうち
 * **冪等性の判定だけ**を Redis へ移す。いきなり切り替えると事故になるので、
 * 段階を env 1 つで表す。
 *
 * | `MARKETING_DELIVERY_STORE` | 書き込み | 判定（read） |
 * |---|---|---|
 * | 未設定 / `airtable` | Airtable のみ | Airtable |
 * | `dual`                  | Airtable **と** Redis | **和集合**（どちらかに有れば送信済み）|
 * | `redis`                 | Redis のみ | Redis |
 *
 * ── なぜ read を「和集合」にするか ──────────────────────────
 * 移行の途中では、古い配信は Airtable にしか無く、新しい配信は両方にある。
 * どちらか一方だけを見ると **片方にしか無い既送信を見落として二重送信する**。
 * 和集合なら、取りこぼしは起きない（多めに除外される方向にしか倒れない）。
 *
 * ── fail closed ────────────────────────────────────────────
 * `dual` / `redis` で Redis が落ちているとき、**「Redis が答えられない＝未送信」
 * と見なしてはいけない**。`dual` は Airtable 側の答えがあるので継続できるが、
 * その事実を戻り値に残して呼び出し側が記録できるようにする。
 * `redis` 単独運用で Redis が落ちたら判定不能なので例外にする。
 */

export const DELIVERY_STORE = Object.freeze({
  AIRTABLE: 'airtable',
  DUAL: 'dual',
  REDIS: 'redis',
});

const VALID = new Set(Object.values(DELIVERY_STORE));

/** env → モード。未知の値は **airtable へ倒す**（勝手に新経路へ行かせない）。 */
export function resolveDeliveryStoreMode(env = process.env) {
  const raw = String((env && env.MARKETING_DELIVERY_STORE) || '').trim().toLowerCase();
  return VALID.has(raw) ? raw : DELIVERY_STORE.AIRTABLE;
}

export function writesAirtable(mode) {
  return mode !== DELIVERY_STORE.REDIS;
}
export function writesRedis(mode) {
  return mode === DELIVERY_STORE.DUAL || mode === DELIVERY_STORE.REDIS;
}
export function readsRedis(mode) {
  return mode === DELIVERY_STORE.DUAL || mode === DELIVERY_STORE.REDIS;
}
export function readsAirtable(mode) {
  return mode === DELIVERY_STORE.AIRTABLE || mode === DELIVERY_STORE.DUAL;
}

/**
 * 既送信の判定を 1 か所にまとめる。
 *
 * @param {{
 *   mode: string,
 *   keys: string[],                                   今回送ろうとしている DeliveryKey
 *   fetchAirtableDelivered?: (keys: string[]) => Promise<Set<string>|string[]>,
 *   fetchRedisDelivered?: (keys: string[]) => Promise<Set<string>|string[]>,
 * }} input
 * @returns {Promise<{ delivered: Set<string>, sources: string[], degraded: null|string }>}
 *   `degraded` は「片側が答えられなかった」印。**判定は続くが、記録に残す**。
 */
export async function resolveDeliveredKeys({
  mode, keys, fetchAirtableDelivered, fetchRedisDelivered,
} = {}) {
  const m = VALID.has(mode) ? mode : DELIVERY_STORE.AIRTABLE;
  const list = Array.isArray(keys) ? keys : [];
  const delivered = new Set();
  const sources = [];
  let degraded = null;

  const asSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));

  if (readsAirtable(m)) {
    if (typeof fetchAirtableDelivered !== 'function') {
      throw new Error('delivery_source:airtable_reader_missing');
    }
    for (const k of asSet(await fetchAirtableDelivered(list))) delivered.add(k);
    sources.push(DELIVERY_STORE.AIRTABLE);
  }

  if (readsRedis(m)) {
    if (typeof fetchRedisDelivered !== 'function') {
      throw new Error('delivery_source:redis_reader_missing');
    }
    try {
      for (const k of asSet(await fetchRedisDelivered(list))) delivered.add(k);
      sources.push(DELIVERY_STORE.REDIS);
    } catch (e) {
      if (m === DELIVERY_STORE.REDIS) {
        // Redis 単独運用で判定できない → **送らない**（fail closed）
        throw e;
      }
      // dual なら Airtable 側の答えがあるので続行できる。ただし黙らない。
      degraded = 'redis_unavailable';
    }
  }

  return { delivered, sources, degraded };
}

/**
 * 送信済みの記録先。**Airtable 側の失敗は従来どおり致命**（台帳が欠ける）。
 * Redis 側の失敗は `dual` なら致命にしない（Airtable が正本のため）が、
 * `redis` モードでは致命（記録が残らないと次回二重送信になる）。
 *
 * @returns {Promise<{ airtable: 'ok'|'skipped', redis: 'ok'|'skipped'|'failed' }>}
 */
export async function recordDelivered({
  mode, keys, writeAirtable, writeRedis,
} = {}) {
  const m = VALID.has(mode) ? mode : DELIVERY_STORE.AIRTABLE;
  const list = Array.isArray(keys) ? keys : [];
  const out = { airtable: 'skipped', redis: 'skipped' };

  if (writesAirtable(m)) {
    if (typeof writeAirtable !== 'function') throw new Error('delivery_source:airtable_writer_missing');
    await writeAirtable(list); // 失敗は throw のまま（台帳が欠けるのは致命）
    out.airtable = 'ok';
  }

  if (writesRedis(m)) {
    if (typeof writeRedis !== 'function') throw new Error('delivery_source:redis_writer_missing');
    try {
      await writeRedis(list);
      out.redis = 'ok';
    } catch (e) {
      if (m === DELIVERY_STORE.REDIS) throw e; // 記録先が無い = 次回二重送信
      out.redis = 'failed'; // dual: Airtable が正本なので継続。差分は reconciliation で拾う
    }
  }

  return out;
}
