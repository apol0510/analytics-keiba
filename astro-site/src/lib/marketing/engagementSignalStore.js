/**
 * engagementSignalStore.js — 受信者ごとの「反応した事実」を O(1) で読み書きする集計（Redis）。
 *
 * ── なぜ台帳を数え直さないのか ──────────────────────────────────
 * 反応（open / click）の生ログは Netlify Blobs の NDJSON（`emailEventBlobStore.js`）に
 * append-only で積まれる。**監査にはそれで足りるが、集計には使えない**:
 *
 *   - 1 バッチ 1 blob なので、件数が増えるほど list + get の往復が増える
 *   - 15,000 名規模の判定を 1 リクエストで作ると Function の実行時間に収まらない
 *   - Airtable の `EmailEvents` は容量対策で Blob へ移し、**行を消した**（`MARKETING_EVENT_SINK=blob`）。
 *     全件走査へ戻すことは禁止（`docs/EMAIL_EVENT_LEDGER.md` / `docs/AIRTABLE_CAPACITY.md`）
 *
 * そこで**受信した瞬間に**アドレス単位の hash へ畳んでおき、読み出しは
 * `HGETALL` 数回で済ませる。生ログ（Blob）が正本で、ここはそこから再構成できる索引。
 *
 * ── 何を持つか（回数は持たない）────────────────────────────────
 * 判定に要るのは「**反応があったか / それはいつか**」だけで、開封回数ではない
 * （`engagementPolicy.js` は open>0 を ACTIVE へ倒すためだけに使う）。
 * よって値は**最後に観測した時刻(ms)**。回数を持たないので:
 *
 *   - 1 バッチにつき `HSET` 1 回（フィールド複数）で書ける = webhook を遅くしない
 *   - provider の再送で二重に数える心配が無い（冪等）
 *
 * ── 個人情報 ────────────────────────────────────────────────
 * フィールド名は**アドレスではなく `EmailHash`**（`emailEventLedger.js` と同じ
 * sha256(lower(email)) の先頭 32 桁）。生アドレスは Redis に入れない。
 *
 * ── 失敗の扱い ──────────────────────────────────────────────
 *  - 書き込み失敗は**致命にしない**（webhook を落とさない）。記録の正本は Blob 側にある
 *  - 読み取り失敗は `available:false`。呼び出し側は「反応が無い」ではなく
 *    **「確認できない」**として扱い、誰も除外しない（fail closed）
 */

import { createHash } from 'node:crypto';

/** 版を上げると別の hash になる（過去の集計と混ざらない） */
export const SIGNAL_SCHEMA = 1;

/** AK 専用の名前空間。KMA / KI とは共有しない */
export const SIGNAL_NAMESPACE = `ak:mkt:eng:v${SIGNAL_SCHEMA}`;

export const SIGNAL_KEY = Object.freeze({
  OPEN: `${SIGNAL_NAMESPACE}:open`,
  CLICK: `${SIGNAL_NAMESPACE}:click`,
  META: `${SIGNAL_NAMESPACE}:meta`,
});

/** meta の項目名（**ここだけ**に置く） */
export const META_FIELD = Object.freeze({
  SCHEMA: 'schema',
  /** この集計が記録を始めた時刻。これより前の配信は「反応を観測できていない」 */
  STARTED_AT: 'started_at',
  /** 最初に open を観測した時刻（open が本当に届いているかの証拠） */
  FIRST_OPEN_AT: 'first_open_at',
  /** 種別を問わず最後にイベントを受けた時刻（Webhook が生きているかの証拠） */
  LAST_EVENT_AT: 'last_event_at',
});

/** `emailEventLedger.js` の `EmailHash` と同じ形（sha256 hex の先頭 32 桁） */
export const EMAIL_HASH_RE = /^[a-f0-9]{32}$/;

/** 1 コマンドに詰めるフィールド数（Upstash の 1 リクエスト上限に余裕を持たせる） */
export const HSET_CHUNK = 400;

export class EngagementSignalError extends Error {
  constructor(reason) {
    super(`engagement_signal:${reason}`); // 値・アドレスはメッセージに載せない
    this.name = 'EngagementSignalError';
    this.reason = reason;
  }
}

const str = (v) => String(v ?? '').trim();

/**
 * アドレス → `EmailHash`。**台帳と同じ作り方**（ここで別の作り方をすると突合できない）。
 * @param {string} email
 * @returns {string} 32 桁 hex（空アドレスなら空文字）
 */
export function hashEmailForSignal(email) {
  const e = str(email).toLowerCase();
  if (!e) return '';
  return createHash('sha256').update(e, 'utf8').digest('hex').slice(0, 32);
}

const ms = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 受信イベント群 → 書き込むべき差分（純粋）。
 *
 * @param {Array<{eventType?:string, emailHash?:string, eventAtMs?:number}>} events
 * @returns {{open: Object<string,number>, click: Object<string,number>,
 *            firstOpenAtMs: number|null, lastEventAtMs: number|null, skipped: number}}
 */
export function buildSignalBumps(events) {
  const open = {};
  const click = {};
  let firstOpenAtMs = null;
  let lastEventAtMs = null;
  let skipped = 0;

  for (const e of Array.isArray(events) ? events : []) {
    const at = ms(e && e.eventAtMs);
    // 種別を問わず「いつ最後に届いたか」は数える（Webhook 停止の検知に使う）
    if (at !== null && (lastEventAtMs === null || at > lastEventAtMs)) lastEventAtMs = at;

    const type = str(e && e.eventType).toLowerCase();
    if (type !== 'open' && type !== 'click') continue;

    const hash = str(e && e.emailHash).toLowerCase();
    if (!EMAIL_HASH_RE.test(hash) || at === null) { skipped += 1; continue; }

    const bucket = type === 'open' ? open : click;
    if (!bucket[hash] || at > bucket[hash]) bucket[hash] = at;
    if (type === 'open' && (firstOpenAtMs === null || at < firstOpenAtMs)) firstOpenAtMs = at;
  }

  return { open, click, firstOpenAtMs, lastEventAtMs, skipped };
}

/** `{hash: ms}` → `HSET` の引数（field, value, field, value, …）を chunk して返す */
export function toHsetArgs(map, chunkSize = HSET_CHUNK) {
  const entries = Object.entries(map || {});
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : HSET_CHUNK;
  const out = [];
  for (let i = 0; i < entries.length; i += size) {
    out.push(entries.slice(i, i + size).flatMap(([f, v]) => [f, String(v)]));
  }
  return out;
}

/**
 * Upstash REST の hash 応答を `Map` へ。
 * 配列形式（`[f, v, f, v]`）とオブジェクト形式の**どちらでも**受ける。
 */
export function parseHashReply(reply) {
  const out = new Map();
  if (!reply) return out;
  if (Array.isArray(reply)) {
    for (let i = 0; i + 1 < reply.length; i += 2) {
      const f = str(reply[i]).toLowerCase();
      if (f) out.set(f, str(reply[i + 1]));
    }
    return out;
  }
  if (typeof reply === 'object') {
    for (const [f, v] of Object.entries(reply)) {
      const k = str(f).toLowerCase();
      if (k) out.set(k, str(v));
    }
  }
  return out;
}

/** `Map<hash, "ms">` → `Map<hash, ms>`（数値化できない値は捨てる） */
export function toTimestampMap(raw) {
  const out = new Map();
  for (const [k, v] of raw || []) {
    const n = ms(v);
    if (n !== null) out.set(k, n);
  }
  return out;
}

/**
 * Redis を使った集計。**I/O は `redisCmd` 注入のみ**（テストで実 Redis を使わない）。
 *
 * @param {{ redisCmd: (args: string[]) => Promise<any> }} deps
 */
export function createEngagementSignalStore({ redisCmd } = {}) {
  if (typeof redisCmd !== 'function') throw new EngagementSignalError('redis_not_configured');

  return {
    /**
     * 受信バッチを畳んで書く。**呼び出し側で握り潰せるよう例外は投げない**
     * （記録の正本は Blob 側。ここが落ちても監査は欠けない）。
     *
     * @returns {Promise<{ok:boolean, open:number, click:number, reason?:string}>}
     */
    async record({ events, receivedAtMs } = {}) {
      try {
        const bumps = buildSignalBumps(events);
        const openCount = Object.keys(bumps.open).length;
        const clickCount = Object.keys(bumps.click).length;
        const now = ms(receivedAtMs);

        for (const args of toHsetArgs(bumps.open)) await redisCmd(['HSET', SIGNAL_KEY.OPEN, ...args]);
        for (const args of toHsetArgs(bumps.click)) await redisCmd(['HSET', SIGNAL_KEY.CLICK, ...args]);

        // 記録開始時刻は**最初の 1 回だけ**（HSETNX）。後から縮めない・伸ばさない
        const startedAt = now ?? bumps.lastEventAtMs;
        if (startedAt !== null) {
          await redisCmd(['HSETNX', SIGNAL_KEY.META, META_FIELD.STARTED_AT, String(startedAt)]);
          await redisCmd(['HSET', SIGNAL_KEY.META, META_FIELD.SCHEMA, String(SIGNAL_SCHEMA)]);
        }
        if (bumps.lastEventAtMs !== null) {
          await redisCmd(['HSET', SIGNAL_KEY.META, META_FIELD.LAST_EVENT_AT, String(bumps.lastEventAtMs)]);
        }
        if (bumps.firstOpenAtMs !== null) {
          await redisCmd(['HSETNX', SIGNAL_KEY.META, META_FIELD.FIRST_OPEN_AT, String(bumps.firstOpenAtMs)]);
        }

        return { ok: true, open: openCount, click: clickCount, skipped: bumps.skipped };
      } catch (e) {
        // 反応の記録が落ちても配信イベントの保存は成立している。数字が古くなるだけ
        return { ok: false, open: 0, click: 0, reason: 'write_failed' };
      }
    },

    /**
     * 集計を読む。**読めなければ `available:false`**（0 件と混同させない）。
     *
     * @returns {Promise<{available:boolean, reason?:string,
     *   openByHash:Map<string,number>, clickByHash:Map<string,number>,
     *   meta:{startedAtMs:number|null, firstOpenAtMs:number|null, lastEventAtMs:number|null}}>}
     */
    async read() {
      try {
        const [openRaw, clickRaw, metaRaw] = await Promise.all([
          redisCmd(['HGETALL', SIGNAL_KEY.OPEN]),
          redisCmd(['HGETALL', SIGNAL_KEY.CLICK]),
          redisCmd(['HGETALL', SIGNAL_KEY.META]),
        ]);
        const meta = parseHashReply(metaRaw);
        return {
          available: true,
          openByHash: toTimestampMap(parseHashReply(openRaw)),
          clickByHash: toTimestampMap(parseHashReply(clickRaw)),
          meta: {
            startedAtMs: ms(meta.get(META_FIELD.STARTED_AT)),
            firstOpenAtMs: ms(meta.get(META_FIELD.FIRST_OPEN_AT)),
            lastEventAtMs: ms(meta.get(META_FIELD.LAST_EVENT_AT)),
          },
        };
      } catch {
        return {
          available: false,
          reason: 'read_failed',
          openByHash: new Map(),
          clickByHash: new Map(),
          meta: { startedAtMs: null, firstOpenAtMs: null, lastEventAtMs: null },
        };
      }
    },
  };
}

/** 集計が使えないときの空の形（呼び出し側で分岐を増やさないため） */
export function emptySignals(reason = 'not_configured') {
  return {
    available: false,
    reason,
    openByHash: new Map(),
    clickByHash: new Map(),
    meta: { startedAtMs: null, firstOpenAtMs: null, lastEventAtMs: null },
  };
}
