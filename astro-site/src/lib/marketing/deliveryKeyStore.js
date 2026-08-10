/**
 * 配信済み `DeliveryKey` の集合を Redis で持つ（二重送信防止の正本を Airtable から外すため）。
 *
 * ── なぜ ────────────────────────────────────────────────────
 * Airtable Team は 1 Base 50,000 レコードで、2026-08-09 に超過した
 * （実測 50,456。詳細は `docs/AIRTABLE_CAPACITY.md`）。
 * `CampaignDeliveries` は 14,416 行あるが、**二重送信防止に必要なのは
 * 「この DeliveryKey は既に送ったか」の 1 問だけ**で、行そのものは要らない。
 * 集合を Redis へ持てば O(1) で判定でき、Airtable のレコードを消費しない。
 *
 * ── 設計上の約束（破ると二重送信になる）──────────────────────
 *  - **`DeliveryKey` の作り方は変えない。** `computeCampaignDeliveryKey`
 *    （brand × serviceType × campaignId × 固定 date × audience × 受信者 ×
 *    contentHash(v付き) × 送信元）が引き続き唯一の生成元。ここでは作らない。
 *  - **TTL を付けない。** 期限切れで消えると「送ったのに未送信」と判定され再送になる。
 *  - **fail open 禁止。** 判定できないときは例外にする。`false`（＝未送信）を
 *    返してはいけない。呼び出し側が握り潰せないよう戻り値ではなく throw。
 *  - **key に PII を入れない。** set のキーは campaign / version / brand だけ。
 *    メンバーの `DeliveryKey` は sha256 hex で、アドレスそのものではない。
 *  - **namespace は AK 専用**（`ak:mkt:`）。KMA / KI とは共有しない。
 *
 * ── 使い分け ────────────────────────────────────────────────
 * 本モジュールは **判定と記録だけ**を担う。どちらを正本にするか（Airtable /
 * Redis / 両方）は `deliveryKeySource.js` の解決に従い、呼び出し側が決める。
 */

/** AK 専用の名前空間。KMA(`CampaignDeliveries_MarketingAutomation`) とは混ぜない。 */
export const NAMESPACE = 'ak:mkt:delivered';

/** set のキーに使ってよい形（PII・記号混入を構造的に防ぐ） */
const SAFE_PART = /^[A-Za-z0-9_.-]{1,120}$/;
/** DeliveryKey は sha256 hex（`computeDeliveryKey` の出力） */
const DELIVERY_KEY = /^[a-f0-9]{64}$/;

/** 1 リクエストに詰めるメンバー数。Upstash の 1 コマンド上限に余裕を持たせる。 */
export const CHUNK = 200;

export class DeliveryKeyStoreError extends Error {
  constructor(reason) {
    super(`delivery_key_store:${reason}`); // 値・アドレスはメッセージに載せない
    this.name = 'DeliveryKeyStoreError';
    this.reason = reason;
  }
}

/**
 * campaign 単位の set キー。
 * **受信者は入れない**（1 campaign 1 set。メンバーが DeliveryKey）。
 */
export function buildDeliveredSetKey({ brand, campaignId, version } = {}) {
  const b = String(brand ?? '').trim();
  const c = String(campaignId ?? '').trim();
  const v = Number(version);
  if (!SAFE_PART.test(b)) throw new DeliveryKeyStoreError('bad_brand');
  if (!SAFE_PART.test(c)) throw new DeliveryKeyStoreError('bad_campaign');
  if (!Number.isInteger(v) || v < 1 || v > 9999) throw new DeliveryKeyStoreError('bad_version');
  return `${NAMESPACE}:${b}:${c}:v${v}`;
}

/** 渡された DeliveryKey が形として正しいか。**壊れた値を黙って通さない**。 */
export function assertDeliveryKeys(keys) {
  if (!Array.isArray(keys)) throw new DeliveryKeyStoreError('keys_not_array');
  for (const k of keys) {
    if (typeof k !== 'string' || !DELIVERY_KEY.test(k)) {
      throw new DeliveryKeyStoreError('bad_delivery_key');
    }
  }
  return keys;
}

export function chunk(list, size = CHUNK) {
  const n = Number.isFinite(size) && size > 0 ? Math.floor(size) : CHUNK;
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * Redis を使った store。
 *
 * @param {{ redisCmd: (args: string[]) => Promise<any> }} deps
 *   `redisCmd` は Upstash REST へ 1 コマンド投げて `result` を返す関数
 *   （既存 Function 群と同じ形）。注入にしてあるのはテストで差し替えるため。
 */
export function createDeliveryKeyStore({ redisCmd } = {}) {
  if (typeof redisCmd !== 'function') throw new DeliveryKeyStoreError('redis_not_configured');

  const call = async (args) => {
    try {
      return await redisCmd(args);
    } catch (e) {
      // ⚠️ ここで false / [] を返してはいけない（未送信と誤判定して二重送信になる）
      throw new DeliveryKeyStoreError('redis_unavailable');
    }
  };

  return {
    /**
     * 既に送った DeliveryKey だけを返す（順序は問わない）。
     * 判定不能なら throw（**fail closed**）。
     */
    async filterDelivered({ brand, campaignId, version, keys }) {
      const setKey = buildDeliveredSetKey({ brand, campaignId, version });
      assertDeliveryKeys(keys);
      if (keys.length === 0) return [];
      const found = [];
      for (const group of chunk(keys)) {
        const res = await call(['SMISMEMBER', setKey, ...group]);
        if (!Array.isArray(res) || res.length !== group.length) {
          throw new DeliveryKeyStoreError('unexpected_response');
        }
        group.forEach((k, i) => { if (Number(res[i]) === 1) found.push(k); });
      }
      return found;
    },

    /** 送信済みとして記録する。**冪等**（同じ鍵を何度足しても集合は変わらない）。 */
    async markDelivered({ brand, campaignId, version, keys }) {
      const setKey = buildDeliveredSetKey({ brand, campaignId, version });
      assertDeliveryKeys(keys);
      if (keys.length === 0) return { added: 0 };
      let added = 0;
      for (const group of chunk(keys)) {
        const res = await call(['SADD', setKey, ...group]);
        added += Number(res) || 0;
      }
      // ⚠️ TTL は付けない。消えると「送ったのに未送信」になり再送する。
      return { added };
    },

    /** 集合の件数（reconciliation 用） */
    async count({ brand, campaignId, version }) {
      const setKey = buildDeliveredSetKey({ brand, campaignId, version });
      const res = await call(['SCARD', setKey]);
      return Number(res) || 0;
    },

    /** 集合の全メンバー（reconciliation 用。件数が多いので SSCAN で回す） */
    async members({ brand, campaignId, version, maxIterations = 2000 }) {
      const setKey = buildDeliveredSetKey({ brand, campaignId, version });
      const out = new Set();
      let cursor = '0';
      let i = 0;
      do {
        const res = await call(['SSCAN', setKey, cursor, 'COUNT', '500']);
        if (!Array.isArray(res) || res.length !== 2) {
          throw new DeliveryKeyStoreError('unexpected_response');
        }
        cursor = String(res[0]);
        for (const m of res[1] || []) out.add(String(m));
        i += 1;
        if (i > maxIterations) throw new DeliveryKeyStoreError('scan_not_converging');
      } while (cursor !== '0');
      return out;
    },
  };
}

/**
 * env から Upstash の呼び出し関数を作る。未設定なら **throw**（fail closed）。
 * URL / token は例外にもログにも出さない。
 */
export function makeRedisCmd(env = process.env) {
  const url = env && env.UPSTASH_REDIS_REST_URL;
  const token = env && env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new DeliveryKeyStoreError('redis_not_configured');
  return async (args) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`); // 値は載せない
    const j = await res.json();
    return j.result;
  };
}
