/**
 * 配信イベントの生ログを Netlify Blobs へ **追記専用**で置く。
 *
 * ── なぜ ────────────────────────────────────────────────────
 * `EmailEvents` は Airtable で 18,793 行あり、Base 上限 50,000 の 37% を占める。
 * `open` / `click` は**重複排除しない**（同じ人が 3 回開けば 3 行）ので、
 * 受信者数ではなく開封回数に比例して無制限に増える。
 * 監査に要るのは「いつ何が起きたか」の記録であって、Airtable の行ではない。
 *
 * ── multi-writer 事故を構造的に避ける ────────────────────────
 * Premium Plus の実績画像で踏んだのは「**同じキーを読んで書き戻す**」形の
 * 競合（eventual consistency + CAS 不成立）だった。ここでは同じ轍を踏まない:
 *
 *   - キーは **バッチごとに固有**（受信時刻 + 内容ハッシュ）
 *   - **新規作成しかしない**。既存 blob を読んで書き足す操作を持たない
 *   - manifest / index を **更新しない**（一覧は prefix の list で得る）
 *
 * したがって webhook が同時に何本走っても、書き込み先が衝突しない。
 * 同じバッチが再送されればキーも同一になり、上書きしても内容が等しい（冪等）。
 *
 * ── 何を保存し、何を捨てるか ──────────────────────────────────
 * provider の生 payload をそのまま置かない。**必要な項目だけ**を写す。
 *   残す: eventKey / type / 発生時刻 / campaign / version / DeliveryKey /
 *         配信レコード id / 顧客レコード id / bounce 分類 / 理由 / provider の id
 *   捨てる: メールアドレス（`EmailHash` だけ残す）/ URL / User-Agent / IP /
 *           `sg_message_id` 以外の内部識別子 / 未知フィールド一切
 */

/** blob キーの先頭。AK 専用（KMA / KI と混ぜない）。 */
export const BLOB_PREFIX = 'ak/email-events';

/** 1 バッチに詰める上限。超える場合は呼び出し側が分割する。 */
export const MAX_EVENTS_PER_BLOB = 1000;

/** 保存してよい項目だけの allow-list。ここに無い値は**書かない**。 */
export const BLOB_EVENT_FIELDS = Object.freeze([
  'eventKey',
  'eventType',
  'eventAtMs',
  'campaignId',
  'campaignVersion',
  'deliveryKey',
  'campaignDeliveryRecordId',
  'customerRecordId',
  'emailHash',
  'bounceClass',
  'reasonText',
  'providerEventId',
  'providerMessageId',
  'resolutionStatus',
]);

export class EmailEventBlobError extends Error {
  constructor(reason) {
    super(`email_event_blob:${reason}`);
    this.name = 'EmailEventBlobError';
    this.reason = reason;
  }
}

const str = (v) => (v === undefined || v === null ? '' : String(v));

/** 理由文はそのまま置かない（長文・アドレス混入があり得る）。 */
function trimReason(v) {
  const s = str(v).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // アドレスらしき部分は落とす（provider の文面に混ざることがある）
  return s.replace(/[^\s@]+@[^\s@]+/g, '[addr]').slice(0, 200);
}

/**
 * 1 イベントを保存形へ。**allow-list 外は落とす**。
 * `email` が来ても保存しない（`emailHash` のみ）。
 */
export function sanitizeEventForBlob(event) {
  const e = event || {};
  const out = {};
  for (const f of BLOB_EVENT_FIELDS) {
    if (f === 'reasonText') { const r = trimReason(e[f]); if (r) out[f] = r; continue; }
    if (f === 'eventAtMs') {
      const n = Number(e[f]);
      if (Number.isFinite(n) && n > 0) out[f] = n;
      continue;
    }
    if (f === 'campaignVersion') {
      const n = Number(e[f]);
      if (Number.isFinite(n)) out[f] = n;
      continue;
    }
    const v = str(e[f]).trim();
    if (v) out[f] = v;
  }
  if (!out.eventKey) throw new EmailEventBlobError('missing_event_key');
  if (!out.eventType) throw new EmailEventBlobError('missing_event_type');
  return out;
}

/** アドレスらしき文字列が混ざっていないか（保存直前の最終防壁） */
export function assertNoRawEmail(records) {
  const re = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/;
  for (const r of records) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string' && re.test(v)) {
        throw new EmailEventBlobError(`raw_email_in:${k}`);
      }
    }
  }
  return true;
}

/** 2 桁ゼロ埋め */
const p2 = (n) => String(n).padStart(2, '0');

/**
 * バッチ固有・不変のキー。
 * **同じ内容のバッチは同じキー**になるので、再送で行が増えない（冪等）。
 *
 * `ak/email-events/YYYY/MM/DD/HHMMSS-<hash12>.ndjson`
 */
export function buildBatchBlobKey({ receivedAtMs, batchHash } = {}) {
  const t = Number(receivedAtMs);
  if (!Number.isFinite(t) || t <= 0) throw new EmailEventBlobError('bad_received_at');
  const h = str(batchHash).trim().toLowerCase();
  if (!/^[a-f0-9]{8,64}$/.test(h)) throw new EmailEventBlobError('bad_batch_hash');
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const key = `${BLOB_PREFIX}/${y}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}`
    + `/${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}-${h.slice(0, 12)}.ndjson`;
  return key;
}

/** NDJSON 本文（1 行 1 イベント）。 */
export function buildNdjson(records) {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

/**
 * バッチを書く。
 *
 * @param {{
 *   setBlob: (key: string, body: string) => Promise<void>,  // 新規作成のみ。読まない
 *   hashFn: (s: string) => string,
 * }} deps
 */
export function createEmailEventBlobStore({ setBlob, hashFn } = {}) {
  if (typeof setBlob !== 'function') throw new EmailEventBlobError('blob_not_configured');
  if (typeof hashFn !== 'function') throw new EmailEventBlobError('hash_not_configured');

  return {
    /**
     * @returns {Promise<{ key: string, written: number }>}
     * 失敗は throw（**握り潰さない**）。呼び出し側が Airtable 側の成否と分けて記録する。
     */
    async writeBatch({ events, receivedAtMs }) {
      const list = Array.isArray(events) ? events : [];
      if (list.length === 0) return { key: null, written: 0 };
      if (list.length > MAX_EVENTS_PER_BLOB) throw new EmailEventBlobError('batch_too_large');

      const records = list.map(sanitizeEventForBlob);
      assertNoRawEmail(records);

      // 内容から決まるハッシュ → 同じバッチの再送は同じキー（上書きしても等価）
      const body = buildNdjson(records);
      const batchHash = hashFn(body);
      const key = buildBatchBlobKey({ receivedAtMs, batchHash });

      // ⚠️ ここで get → merge → set をしてはいけない（multi-writer 事故の元）
      await setBlob(key, body);
      return { key, written: records.length };
    },
  };
}
