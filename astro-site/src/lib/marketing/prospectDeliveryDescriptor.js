/**
 * prospectDeliveryDescriptor.js — prospect 1 通ぶんの「配信の身分証」を Redis で持ち回す
 *
 * ## なぜ要るか
 *
 * prospect（CSV 取り込みプール）は **Airtable に配信行を作らない**（2026-08-27 MK 確定 /
 * レコード上限対策）。ところが送信側は `custom_args` を
 * `CampaignDeliveries` の行からしか作れなかったため、**prospect には 1 通も送れなかった**
 * （`delivery_not_found` で必ず skip。2026-09-14 実測）。
 *
 * 足りないのは「この 1 通の `DeliveryKey` は何か」だけ。
 * それは **enqueue の瞬間に確定している**（`claimDelivered` で予約した鍵そのもの）。
 * そこで積むときに **jobId ごとの対応表**を Redis へ置き、送信時にそれを読む。
 *
 * ⚠️ **鍵を送信側で作り直さない。** 作り直すと、送信元アドレスや step の取り違えで
 *    別の鍵になり、台帳と永久に噛み合わなくなる（2026-08 に実際に起きた）。
 * ⚠️ 置くのは `emailHash → DeliveryKey` **だけ**。生アドレスは置かない
 *    （`ak:prospect:` 以外でアドレスを保存しないという既存方針を守る）。
 *
 * ## 二重送信の防ぎ方
 *
 * Customers 由来は配信行の `Status='sent'` が「もう送った」の証拠になる。
 * prospect にはその行が無いので、**送れた相手を job ごとの集合へ記録**し、
 * 次に同じ job が起動されても送らない（`markSent` / `loadSent`）。
 *
 * ⚠️ 記録できなければ**送らない**（fail closed）。記録できないまま送ると、
 *    同じ job の再起動で同じ人へもう 1 通出る。
 */

/** jobId → 対応表（HASH: emailHash → DeliveryKey） */
export const JOB_DELIVERY_ROOT = 'ak:mkt:jobdelivery:v1:';
/** jobId → 送信済み（SET: emailHash） */
export const JOB_SENT_ROOT = 'ak:mkt:jobsent:v1:';

/**
 * 対応表の寿命。**積んでから送るまで**の間だけ持てばよいが、滞留したジョブが
 * 後から片付くこともあるので十分に長く取る（30 日）。
 * ⚠️ 短くしすぎると、滞留ジョブが「鍵が読めないので送れない」に変わる。
 */
export const DESCRIPTOR_TTL_SEC = 30 * 24 * 60 * 60;

const str = (v) => String(v ?? '').trim();
const DELIVERY_KEY = /^[a-f0-9]{64}$/;
const EMAIL_HASH = /^[a-f0-9]{32,64}$/;

/** 安全な jobId か（Redis キーへ入れてよい文字だけ） */
export function isSafeJobKey(jobId) {
  return /^[A-Za-z0-9._:-]{1,200}$/.test(str(jobId));
}

/**
 * 受信者 → 対応表のエントリ。**prospect だけ**を対象にする。
 *
 * @param {{recipients: Array<{email: string, deliveryKey: string, 出所?: string, source?: string}>,
 *          hashFn: (email: string) => string}} input
 * @returns {{entries: Array<{emailHash: string, deliveryKey: string}>, dropped: number}}
 */
export function buildDescriptorEntries({ recipients, hashFn } = {}) {
  const entries = [];
  let dropped = 0;
  const seen = new Set();
  for (const r of Array.isArray(recipients) ? recipients : []) {
    const source = str((r && (r['出所'] ?? r.source)) || '');
    if (source !== 'prospect') continue;
    const email = str(r && r.email).toLowerCase();
    const key = str(r && r.deliveryKey);
    if (!email || !DELIVERY_KEY.test(key) || typeof hashFn !== 'function') { dropped += 1; continue; }
    const h = str(hashFn(email));
    if (!EMAIL_HASH.test(h) || seen.has(h)) { dropped += 1; continue; }
    seen.add(h);
    entries.push({ emailHash: h, deliveryKey: key });
  }
  return { entries, dropped };
}

/**
 * 対応表の値 → `buildCampaignCustomArgs` が受け取る delivery 記述子。
 *
 * ⚠️ `recordId` / `customerRecordId` は**持たせない**（Airtable の行が無いため）。
 *    `source: 'prospect'` が、その欠落が設計どおりであることの印になる。
 */
export function toProspectDelivery({ deliveryKey, campaignId, campaignVersion } = {}) {
  const key = str(deliveryKey);
  if (!DELIVERY_KEY.test(key)) return null;
  const id = str(campaignId);
  const version = str(campaignVersion);
  if (!id || !version) return null;
  return {
    source: 'prospect',
    deliveryKey: key,
    campaignType: `${id}:v${version}`,
    status: 'queued',
  };
}

/**
 * Redis 側。`redisCmd` が無ければ **使えない store** を返す（呼び出し側が fail closed で扱う）。
 *
 * @param {{redisCmd?: Function, redisPipeline?: Function}} deps
 */
export function createJobDeliveryStore({ redisCmd, redisPipeline } = {}) {
  const usable = typeof redisCmd === 'function';
  const call = async (args) => {
    const r = await redisCmd(args);
    return r && typeof r === 'object' && 'result' in r ? r.result : r;
  };
  return {
    usable,

    /**
     * 対応表を保存する。**1 件でも保存できなければ false**（呼び出し側は積まない）。
     * 既存の値は上書きしない方が安全だが、同じ jobId は同じ母集団・同じ鍵になるので
     * `HSET` の上書きは実質同値（plan fingerprint が jobId の材料）。
     */
    async save({ jobId, entries, ttlSec = DESCRIPTOR_TTL_SEC }) {
      if (!usable || !isSafeJobKey(jobId)) return false;
      const list = Array.isArray(entries) ? entries : [];
      if (list.length === 0) return true;              // 書くものが無い＝成功（prospect 不在）
      const key = `${JOB_DELIVERY_ROOT}${jobId}`;
      const args = ['HSET', key];
      for (const e of list) args.push(e.emailHash, e.deliveryKey);
      try {
        if (typeof redisPipeline === 'function') {
          await redisPipeline([args, ['EXPIRE', key, String(ttlSec)]]);
        } else {
          await call(args);
          await call(['EXPIRE', key, String(ttlSec)]);
        }
        return true;
      } catch {
        return false;
      }
    },

    /**
     * 対応表を読む。**読めなければ null**（0 件と区別する。null なら送らない）。
     * @returns {Promise<Map<string,string>|null>} emailHash → DeliveryKey
     */
    async load({ jobId }) {
      if (!usable || !isSafeJobKey(jobId)) return null;
      try {
        const raw = await call(['HGETALL', `${JOB_DELIVERY_ROOT}${jobId}`]);
        const out = new Map();
        if (Array.isArray(raw)) {
          for (let i = 0; i + 1 < raw.length; i += 2) {
            const h = str(raw[i]); const k = str(raw[i + 1]);
            if (EMAIL_HASH.test(h) && DELIVERY_KEY.test(k)) out.set(h, k);
          }
        } else if (raw && typeof raw === 'object') {
          for (const [h, k] of Object.entries(raw)) {
            if (EMAIL_HASH.test(str(h)) && DELIVERY_KEY.test(str(k))) out.set(str(h), str(k));
          }
        }
        return out;
      } catch {
        return null;
      }
    },

    /**
     * この job で**もう送った** prospect（emailHash の集合）。
     * **読めなければ null**（分からないまま送らない）。
     */
    async loadSent({ jobId }) {
      if (!usable || !isSafeJobKey(jobId)) return null;
      try {
        const raw = await call(['SMEMBERS', `${JOB_SENT_ROOT}${jobId}`]);
        const out = new Set();
        for (const h of Array.isArray(raw) ? raw : []) {
          const s = str(h);
          if (EMAIL_HASH.test(s)) out.add(s);
        }
        return out;
      } catch {
        return null;
      }
    },

    /**
     * 送れた相手を記録する。**記録できたときだけ true**。
     * ⚠️ 送信の**前**に呼ぶこと。記録できないまま送ると、再起動で二重送信になる。
     */
    async markSent({ jobId, emailHashes, ttlSec = DESCRIPTOR_TTL_SEC }) {
      if (!usable || !isSafeJobKey(jobId)) return false;
      const list = [...new Set((emailHashes || []).map(str).filter((h) => EMAIL_HASH.test(h)))];
      if (list.length === 0) return true;
      const key = `${JOB_SENT_ROOT}${jobId}`;
      try {
        if (typeof redisPipeline === 'function') {
          await redisPipeline([['SADD', key, ...list], ['EXPIRE', key, String(ttlSec)]]);
        } else {
          await call(['SADD', key, ...list]);
          await call(['EXPIRE', key, String(ttlSec)]);
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}

export default createJobDeliveryStore;
