/**
 * batchEventWindow.js — 前バッチで**実際に起きたイベント**を数える（純粋・I/O なし）
 *
 * ── なぜ要るか（3 度目の正直）────────────────────────────────
 * バッチ健全性の入力を 2 度間違えた。
 *   1 度目 … `byStopReason` の**累積**（＝いま候補を除外する理由）をそのまま苦情として渡した
 *            → コホートに元から居る停止リスト該当者 1 名で永久停止
 *   2 度目 … その**差分**を取った
 *            → 展開は 1 バッチ 500 名ずつ母集団が増えるので、
 *              以前から停止リストに載っていた人が入るだけで差分が増える
 *   3 度目（未遂）… `EmailBlacklist` を数えようとした
 *            → あれは**アドレス 1 行の upsert 台帳**（既存行は PATCH で
 *              `BounceCount+1` / `BounceType` 上書き・`AddedAt` は据え置き）。
 *              1 イベント 1 行ではないので、古い登録者の新イベントを取り逃がす。
 *
 * ── 正しい正本 ────────────────────────────────────────────────
 * **メール配信イベントの恒久台帳**（`emailEventLedger.js` / `emailEventBlobStore.js`）。
 * Event Webhook が受けた 1 イベントを **NDJSON の 1 行**として保存する
 * （`ak/email-events/YYYY/MM/DD/HHMMSS-<hash>.ndjson`）。
 *
 *   `eventType`   … delivered / open / bounce / dropped / spamreport / unsubscribe …
 *   `eventAtMs`   … 発生時刻（**窓で切れる**）
 *   `campaignId` / `campaignVersion` … どの配信か（**他 campaign を混ぜない**）
 *   `deliveryKey` … 配信 1 通の一意キー（**直前バッチへ scope できる**）
 *   `bounceClass` … provider の bounce 種別（`hard` / `soft`）
 *   `providerEventId` … 1 イベント 1 値（**再送を二重に数えない**）
 *
 * ⚠️ ここは数えるだけ。しきい値は `batchHealth.js`（既存契約・変更しない）。
 * ⚠️ 読めない（`records` が配列でない）ときは **null**。呼び出し側が fail closed する。
 */

/** 苦情として数えるイベント */
export const COMPLAINT_EVENTS = Object.freeze(['spamreport']);
/** 配信停止として数えるイベント */
export const UNSUBSCRIBE_EVENTS = Object.freeze(['unsubscribe', 'group_unsubscribe']);
/** ハードバウンス相当として数えるイベント（`dropped` は送信前に弾かれた＝到達不能） */
export const HARD_BOUNCE_EVENTS = Object.freeze(['dropped']);

const str = (v) => String(v ?? '').trim();
const lower = (v) => str(v).toLowerCase();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 1 イベントを分類する。**分からないものはどれにも数えない**（推測しない）。
 *
 * @returns {'complaints'|'unsubscribes'|'bounces'|'softBounces'|null}
 */
export function classifyEvent(record) {
  const r = record || {};
  const type = lower(r.eventType);
  if (COMPLAINT_EVENTS.includes(type)) return 'complaints';
  if (UNSUBSCRIBE_EVENTS.includes(type)) return 'unsubscribes';
  if (HARD_BOUNCE_EVENTS.includes(type)) return 'bounces';
  if (type === 'bounce') {
    // ⚠️ **soft は hard として数えない**（既存しきい値はハード想定）
    const cls = lower(r.bounceClass);
    if (cls === 'soft' || cls === 'blocked') return 'softBounces';
    return 'bounces';
  }
  return null;
}

/**
 * 窓の中の、**この campaign の、直前バッチに属する**イベントだけを数える。
 *
 * @param {object} input
 * @param {object[]|null} input.records      台帳の行（NDJSON をパースしたもの）
 * @param {string} input.campaignId          この展開の campaign（**他は数えない**）
 * @param {number|null} input.sinceMs        バッチ開始時刻（これ以降のイベントだけ）
 * @param {Set<string>|string[]|null} [input.deliveryKeys]
 *        直前バッチの DeliveryKey。**渡せば厳密に scope する**（渡さなければ campaign + 時刻窓）
 * @returns {{complaints, unsubscribes, bounces, softBounces, counted, skipped}|null}
 */
export function summarizeEventWindow({ records, campaignId, sinceMs, deliveryKeys = null } = {}) {
  if (!Array.isArray(records)) return null;
  const wantKeys = deliveryKeys
    ? (deliveryKeys instanceof Set ? deliveryKeys : new Set(deliveryKeys))
    : null;
  const since = num(sinceMs);
  const camp = str(campaignId);
  const out = {
    complaints: 0, unsubscribes: 0, bounces: 0, softBounces: 0,
    counted: 0,
    skipped: { otherCampaign: 0, beforeWindow: 0, otherBatch: 0, otherType: 0, noTime: 0 },
  };
  /** 同じ provider イベントを 2 回数えない（webhook 再送・blob 重複） */
  const seen = new Set();

  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    // ① この campaign のものだけ（他 campaign のバウンスを混ぜない）
    if (camp && lower(r.campaignId) !== lower(camp)) { out.skipped.otherCampaign += 1; continue; }
    // ② 直前バッチの通だけ（鍵を渡された場合）
    if (wantKeys && !wantKeys.has(str(r.deliveryKey))) { out.skipped.otherBatch += 1; continue; }
    // ③ バッチ開始以降のイベントだけ
    const at = num(r.eventAtMs);
    if (since !== null) {
      if (at === null) { out.skipped.noTime += 1; continue; }
      if (at < since) { out.skipped.beforeWindow += 1; continue; }
    }
    // ④ 種別
    const kind = classifyEvent(r);
    if (!kind) { out.skipped.otherType += 1; continue; }
    // ⑤ 冪等（1 イベント 1 回）
    const id = str(r.providerEventId) || str(r.eventKey);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out[kind] += 1;
    out.counted += 1;
  }
  return out;
}

/**
 * 窓が跨ぐ **UTC 日付**の一覧（blob の鍵が UTC 日付で切られているため）。
 * ⚠️ 上限つき。長すぎる窓は**数え切れない**として呼び出し側が fail closed する。
 */
export function windowDates(sinceMs, untilMs, maxDays = 3) {
  const from = num(sinceMs);
  const to = num(untilMs);
  if (from === null || to === null || to < from) return null;
  const out = [];
  const day = 86400_000;
  const start = Date.UTC(
    new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate(),
  );
  for (let t = start; t <= to; t += day) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
    if (out.length > maxDays) return null;
  }
  return out;
}

export default summarizeEventWindow;
