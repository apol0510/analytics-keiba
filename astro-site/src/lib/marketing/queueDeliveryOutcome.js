/**
 * queueDeliveryOutcome.js — キュー登録を**成功と言ってよいか**を決める（純粋・I/O なし）
 *
 * ── 何が起きたか（2026-08-18 の本番事故）──────────────────────────
 * キュー登録は `admin-marketing.js` で
 *
 *   1. `ScheduledEmails` に PENDING ジョブ行を作る
 *   2. `CampaignDeliveries` を `DeliveryKey` 冪等で upsert する
 *
 * の順に進む。**この 2 つは 1 つの取引になっていない**ので、2 で落ちると
 * **配信行の無い orphan PENDING ジョブ**だけが残る（この故障形は
 * `admin-marketing.js` の重複確認コメントにも既に明記されている）。
 *
 * 本番実測: ジョブ 1 件（宛先 100）が作られ、`CampaignDeliveries` は
 * **0 行**（12:00Z 以降どの CampaignType にも 1 行も増えていない）。
 * dispatcher は配信行が無い宛先へは送らないので
 * （`campaignCustomArgs.js` の `delivery_not_found`）、
 * この PENDING ジョブは**起動しても永久に送れない**。
 *
 * ── ここが守ること ────────────────────────────────────────────
 * ⚠️ **配信行の作成を「正に確認」できないかぎり、キュー登録を成功と言わない。**
 *    `upsertDeliveries` が例外を投げなかったことは「書けた」の証拠にならない
 *    （組み立て段で 0 件に落ちていれば HTTP を 1 回も呼ばずに素通りする）。
 * ⚠️ **部分成功を 0 件にも成功にも丸めない。** 何件期待して何件書けたかを数で返す。
 * ⚠️ 判定はここだけ。書き込み・補償（orphan ジョブの取消）は呼び出し側の仕事。
 *
 * ── 再実行しても二重にならない ────────────────────────────────
 * 配信行は `DeliveryKey` をマージキーにした upsert なので、同じ鍵で何度書いても
 * 行は増えない（`admin-marketing.js#upsertDeliveries` の `performUpsert`）。
 * したがって「失敗 → 補償 → 再実行」は安全に繰り返せる。
 */

/** キュー登録を成功と言えない理由（固定コード。アドレスも鍵も混ぜない） */
export const QUEUE_FAIL = Object.freeze({
  /** 宛先に対して組み立てた配信行が足りない（`buildDeliveryRecords` の黙った取りこぼし） */
  RECORDS_DROPPED: 'delivery_records_dropped',
  /** 宛先から配信鍵を作れていない */
  KEYS_MISSING: 'delivery_keys_missing',
  /** 書けたかどうかを読み戻せない（**0 件と言わない**） */
  UNVERIFIED: 'deliveries_unverified',
  /** 書けた数が足りない（部分成功を含む） */
  INCOMPLETE: 'deliveries_incomplete',
  /** そもそも宛先が無い */
  NO_RECIPIENTS: 'no_recipients',
});

const str = (v) => String(v ?? '').trim();

/** 鍵の集合を作る（空は落とすが、**落ちた事実は呼び出し側が数で気づける**） */
export function collectDeliveryKeys(recipients) {
  const out = new Set();
  for (const r of Array.isArray(recipients) ? recipients : []) {
    const k = str(r && r.deliveryKey);
    if (k) out.add(k);
  }
  return out;
}

const toSet = (v) => {
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v.map(str).filter(Boolean));
  return null;
};

/**
 * キュー登録を成功と言ってよいか。
 *
 * @param {{recipients: object[], builtCount: number,
 *          verifiedKeys: Set<string>|string[]|null}} input
 *   `verifiedKeys` … **台帳を読み戻して実在を確認できた** DeliveryKey。
 *                    読めなければ `null`（fail closed）
 * @returns {{ok: boolean, reason: string|null, expected: number,
 *            built: number, verified: number, missing: number}}
 */
export function classifyQueueOutcome({ recipients, builtCount, verifiedKeys } = {}) {
  const list = Array.isArray(recipients) ? recipients : [];
  const keys = collectDeliveryKeys(list);
  const expected = keys.size;
  const built = Number.isFinite(Number(builtCount)) ? Number(builtCount) : -1;
  const base = {
    expected, built: built < 0 ? 0 : built, verified: 0, missing: expected,
  };

  if (list.length === 0) return { ok: false, reason: QUEUE_FAIL.NO_RECIPIENTS, ...base };
  // 宛先はあるのに鍵が作れていない = 冪等の土台が無い
  if (expected === 0 || expected !== list.length) {
    return { ok: false, reason: QUEUE_FAIL.KEYS_MISSING, ...base };
  }
  // 組み立て段で黙って落ちていないか（**数が合わなければ書きにいかない**）
  if (built !== expected) return { ok: false, reason: QUEUE_FAIL.RECORDS_DROPPED, ...base };

  const verified = toSet(verifiedKeys);
  // 読み戻せない = 書けたと言えない（**0 件とも言わない**）
  if (verified === null) return { ok: false, reason: QUEUE_FAIL.UNVERIFIED, ...base };

  let present = 0;
  for (const k of keys) if (verified.has(k)) present += 1;
  const missing = expected - present;
  if (missing > 0) {
    return {
      ok: false, reason: QUEUE_FAIL.INCOMPLETE,
      expected, built, verified: present, missing,
    };
  }
  return { ok: true, reason: null, expected, built, verified: present, missing: 0 };
}

export default classifyQueueOutcome;
