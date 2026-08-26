/**
 * engagementBlocklistStore.js — 「反応が無いので送らない」相手を送信直前にも参照できるようにする
 *
 * ## なぜ要るか（2026-08-26 MK 確定）
 *
 * 「累計 10 通 delivered で開封 0」の判定には**配信台帳の全履歴**が要る。
 * それは Function の実行時間では読み切れない（`CampaignDeliveries` は実測 14,000 行超）。
 * そのため実送信の直前に同じ計算をやり直すことはできない。
 *
 * そこで **計算できる場所（下見・enqueue）で結果を書き、送る場所（dispatcher）で読む**。
 * 判定そのものは `engagementGuard.js` が単一源で、ここは**結果の受け渡しだけ**を担う。
 *
 * ## fail closed の向き
 *
 * ここでの安全側は「**除外しない**」。
 * 「反応が無い」と「観測できていない」を取り違えると、開封している人を切ってしまう。
 * よって次のときは **1 人も除外しない**:
 *
 *   - Redis を読めない
 *   - 一覧がまだ書かれていない
 *   - 書かれてから時間が経ちすぎている（古い判断で切らない）
 *
 * ⚠️ アドレスは**ハッシュで持たない**。ここは送信直前の照合に使うので素のアドレスが要る。
 *    Redis は本番 env でのみ到達でき、値は外部へ出さない（応答にも載せない）。
 * ⚠️ 取引メール（決済・認証・サポート・期限通知）はこの一覧を**参照しない**。
 */

/** 一覧の置き場所（1 キーだけ。増やさない） */
export const BLOCKLIST_KEY = 'ak:marketing:engagement-blocked:v1';
/** 最終更新時刻（ms epoch） */
export const BLOCKLIST_META_KEY = 'ak:marketing:engagement-blocked:v1:meta';

/** これより古い一覧は使わない（既定 48 時間） */
export const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export const BLOCKLIST_SKIP = Object.freeze({
  NOT_CONFIGURED: 'redis_not_configured',
  UNAVAILABLE: 'blocklist_unavailable',
  EMPTY: 'blocklist_empty',
  STALE: 'blocklist_stale',
});

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** 空の結果（＝誰も除外しない） */
export function emptyBlocklist(reason) {
  return { usable: false, reason, emails: new Set(), computedAtMs: null, count: 0 };
}

/**
 * @param {{ redisCmd: (args: string[]) => Promise<any> }} deps
 */
export function createEngagementBlocklistStore({ redisCmd } = {}) {
  if (typeof redisCmd !== 'function') throw new Error('redis_not_configured');

  return {
    /**
     * 判定結果を丸ごと置き換える（差分更新しない。古い相手が残り続けないように）。
     * **`applied:false` のときは呼ばない**（材料が無い状態の結果を保存しない）。
     */
    async write({ emails, computedAtMs } = {}) {
      const list = [...(emails instanceof Set ? emails : new Set())].map(norm).filter(Boolean);
      const at = Number.isFinite(Number(computedAtMs)) ? Number(computedAtMs) : Date.now();
      await redisCmd(['DEL', BLOCKLIST_KEY]);
      for (let i = 0; i < list.length; i += 200) {
        const chunk = list.slice(i, i + 200);
        if (chunk.length) await redisCmd(['SADD', BLOCKLIST_KEY, ...chunk]);
      }
      await redisCmd(['SET', BLOCKLIST_META_KEY, String(at)]);
      return { ok: true, count: list.length, computedAtMs: at };
    },

    /**
     * 送信直前に読む。**古い / 空 / 読めない は使わない**（誰も除外しない）。
     */
    async read({ nowMs = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
      let members;
      let metaRaw;
      try {
        [members, metaRaw] = await Promise.all([
          redisCmd(['SMEMBERS', BLOCKLIST_KEY]),
          redisCmd(['GET', BLOCKLIST_META_KEY]),
        ]);
      } catch {
        return emptyBlocklist(BLOCKLIST_SKIP.UNAVAILABLE);
      }
      const list = Array.isArray(members) ? members.map(norm).filter(Boolean) : [];
      const computedAtMs = Number(metaRaw);
      if (!Number.isFinite(computedAtMs) || computedAtMs <= 0) return emptyBlocklist(BLOCKLIST_SKIP.EMPTY);
      if (Number(nowMs) - computedAtMs > Number(maxAgeMs)) {
        return { ...emptyBlocklist(BLOCKLIST_SKIP.STALE), computedAtMs };
      }
      if (list.length === 0) return { ...emptyBlocklist(BLOCKLIST_SKIP.EMPTY), computedAtMs };
      return { usable: true, reason: null, emails: new Set(list), computedAtMs, count: list.length };
    },
  };
}
