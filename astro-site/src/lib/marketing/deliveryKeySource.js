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

/* ────────────────────────────────────────────────────────────────────────────
 * 受信者の「出所」ごとの台帳の置き場所（2026-08-27 MK 確定）
 *
 * ## なぜ env だけでは足りないか
 *
 * `MARKETING_DELIVERY_STORE` は**サイト全体の 1 つのつまみ**で、本番はいま `dual`
 * （Airtable と Redis の両方へ書く）。この状態で CSV 由来の 1 万数千名へ 1 通送ると
 * **受信者 × step のぶんだけ `CampaignDeliveries` の行が増える**。
 *
 * 実測（2026-08-27・本番）:
 *
 *   Airtable 全 13 table 合計 **50,789 件 / 上限 50,000 件（Team）** ＝ **超過中**
 *   うち `CampaignDeliveries` が **33,112 件**（`Customers` 15,976 件の 2 倍以上）
 *
 * つまり **Customers を減らすだけでは上限問題は解決しない**。むしろ増加の主因は
 * 配信台帳の側で、CSV 由来へ step2 / step3 を配ると 1 回ごとに 1 万数千行増える。
 *
 * ## 決めたこと
 *
 * **prospect（CSV 取り込み由来）の配信台帳は Airtable へ書かない。**
 * env のモードに関わらず構造的にそうする。冪等性は Redis の集合が担う
 * （`deliveryKeyStore.js`。`DeliveryKey` の作り方は変えないので鍵は同じ）。
 *
 *   - **読み**は従来どおりモードに従う（移行途中は Airtable にも古い行があるので
 *     和集合で読まないと既送信を見落として二重送信になる）
 *   - **書き**だけを Redis 限定にする（行を増やさない）
 *
 * ⚠️ Customers 由来の受信者は**従来どおり**（モードに従う）。ここは変えない。
 * ⚠️ `redis` モードで Redis が落ちていれば従来どおり致命（`recordDelivered`）。
 *    prospect も同じで、記録できないなら送らない（fail closed）。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 受信者の出所。`prospectPipeline.mergeAudiences()` が付ける値と同じ */
export const RECIPIENT_SOURCE = Object.freeze({
  CUSTOMER: 'customer',
  PROSPECT: 'prospect',
});

/**
 * この受信者ぶんの台帳をどこへ書き、どこから読むか。
 *
 * @param {{mode:string, source:string}} input
 * @returns {{writeAirtable:boolean, writeRedis:boolean,
 *            readAirtable:boolean, readRedis:boolean, forcedBySource:boolean}}
 */
export function resolveRecipientLedgerPolicy({ mode, source } = {}) {
  const m = VALID.has(mode) ? mode : DELIVERY_STORE.AIRTABLE;
  const isProspect = String(source ?? '').trim().toLowerCase() === RECIPIENT_SOURCE.PROSPECT;
  return {
    // ⚠️ prospect は **Airtable へ書かない**（レコード上限を食い潰さない）
    writeAirtable: isProspect ? false : writesAirtable(m),
    // prospect は必ず Redis へ記録する（記録が無ければ次回二重送信になる）
    writeRedis: isProspect ? true : writesRedis(m),
    // 読みはモードに従う。移行途中の既送信（Airtable のみ）を見落とさないため
    readAirtable: readsAirtable(m),
    readRedis: isProspect ? true : readsRedis(m),
    forcedBySource: isProspect,
  };
}

/**
 * 「この配信で Airtable の行が何件増えるか」を先に出す。
 *
 * 上限が近いので、**送る前に増加量が分かる**ようにしておく。
 * `airtableRows` が 0 でないなら、その数だけ上限へ近づく。
 *
 * @param {{mode:string, recipients:Array<{出所?:string, source?:string}>, steps?:number}} input
 */
export function projectAirtableLedgerGrowth({ mode, recipients, steps = 1 } = {}) {
  const list = Array.isArray(recipients) ? recipients : [];
  const n = Number.isInteger(steps) && steps > 0 ? steps : 1;
  let airtableRows = 0; let redisMembers = 0;
  let customer = 0; let prospect = 0;
  for (const r of list) {
    const src = String((r && (r['出所'] ?? r.source)) ?? RECIPIENT_SOURCE.CUSTOMER).trim().toLowerCase();
    const policy = resolveRecipientLedgerPolicy({ mode, source: src });
    if (src === RECIPIENT_SOURCE.PROSPECT) prospect += 1; else customer += 1;
    if (policy.writeAirtable) airtableRows += n;
    if (policy.writeRedis) redisMembers += n;
  }
  return {
    steps: n,
    recipients: { customer, prospect, total: list.length },
    /** Airtable のレコード上限を消費する行数（**0 が目標**） */
    airtableRows,
    /** Redis の集合メンバー数（上限を消費しない） */
    redisMembers,
  };
}

/**
 * 受信者を**台帳の書き先ごとに分ける**（enqueue の配線用）。
 *
 * `recordDelivered()` は「1 つのモード × 鍵の配列」しか受け取らないので、
 * customer と prospect が混ざった配信では **2 回に分けて呼ぶ**必要がある。
 * その分け方をここに固定しておく（呼び出し側で毎回書き分けない）。
 *
 * ⚠️ **`airtableKeys` に prospect の鍵が 1 つでも混ざってはいけない。**
 *    混ざるとその人数ぶん Airtable の行が増える（上限を超過中）。
 *
 * @param {{mode:string, recipients:Array<{deliveryKey?:string, 出所?:string, source?:string}>}} input
 * @returns {{airtableKeys:string[], redisKeys:string[], dropped:number}}
 */
export function partitionRecipientsForLedger({ mode, recipients } = {}) {
  const airtableKeys = []; const redisKeys = [];
  let dropped = 0;
  for (const r of Array.isArray(recipients) ? recipients : []) {
    const key = String((r && r.deliveryKey) || '').trim();
    if (!key) { dropped += 1; continue; }
    const src = String((r && (r['出所'] ?? r.source)) ?? RECIPIENT_SOURCE.CUSTOMER).trim().toLowerCase();
    const policy = resolveRecipientLedgerPolicy({ mode, source: src });
    if (policy.writeAirtable) airtableKeys.push(key);
    if (policy.writeRedis) redisKeys.push(key);
  }
  return { airtableKeys, redisKeys, dropped };
}
