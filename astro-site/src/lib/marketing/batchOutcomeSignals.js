/**
 * batchOutcomeSignals.js — 前バッチで**実際に起きたこと**だけを数える（純粋・I/O なし）
 *
 * ── なぜ要るか（入力を 3 度間違えた）──────────────────────────
 *   1 度目 … `action=sequence` の `byStopReason`（**いま候補を除外する理由** ＝ 現在状態）を
 *            累積のまま苦情として渡し、元から居る停止リスト該当者 1 名で永久停止
 *   2 度目 … その差分を取ったが、展開は 1 バッチ 500 名ずつ母集団が増えるので、
 *            **以前から該当していた人が母集団へ入るだけで差分が増える**
 *   3 度目（未遂）… `EmailBlacklist` を数えようとしたが、あれは**アドレス 1 行の upsert 台帳**
 *            （既存行は `BounceCount+1` の PATCH・`AddedAt` 据え置き）で 1 イベント 1 行ではない
 *
 * ── 正しい source（既存の正本）──────────────────────────────
 * spam complaint / unsubscribe / hard bounce の正本は**配信イベント台帳**
 * （`emailEventBlobStore.js` の NDJSON。**1 行 1 イベント**）。
 * 分類・窓・重複除去は `batchEventWindow.js` が単一源で、ここは受け取るだけ。
 *
 * ⚠️ `EmailBlacklist` は使わない。**アドレス 1 行の upsert 台帳**で、
 *    既存行は PATCH（`BounceCount+1` / `BounceType` 上書き / `AddedAt` 据え置き）。
 *    1 イベント 1 行ではないので、**古い登録者の新イベントを取り逃がす**。
 *
 * 送信・失敗は**ジョブ台帳**（`ScheduledEmails` の `sentCount` / `failedCount`）が正本で、
 * これは前バッチの送信でしか増えない。二重送信は **DeliveryKey** が構造的に防ぎ、
 * 送信経路が `already_delivered` として弾いた数を duplicate として受け取る。
 *
 * ⚠️ ここは**数えるだけ**。しきい値の判断は `batchHealth.js`（既存契約・変更しない）。
 * ⚠️ 読めない指標は `null`（0 と書かない）。呼び出し側が fail closed する。
 */

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v) => String(v ?? '').trim().toLowerCase();

/**
 * 前バッチの健全性入力を 1 つにまとめる。
 *
 * ⚠️ `sent` / `failed` / `duplicates` は**累計**（差分で前バッチぶんにする）。
 *    `complaints` / `unsubscribes` / `bounces` は
 *    **すでに窓で切られた「前バッチで起きた回数」そのもの**（差分を取らない）。
 *
 * @param {{jobsSent: number|null, jobsFailed: number|null,
 *          duplicates: number|null, events: object|null}} input
 *   `events` … `summarizeEventWindow()` の戻り（読めなければ null）
 */
export function captureOutcomeSnapshot({ jobsSent, jobsFailed, duplicates, events } = {}) {
  const e = events && typeof events === 'object' ? events : null;
  return {
    sent: num(jobsSent),
    failed: num(jobsFailed),
    duplicates: num(duplicates),
    complaints: e ? (num(e.complaints) ?? 0) : null,
    unsubscribes: e ? (num(e.unsubscribes) ?? 0) : null,
    bounces: e ? (num(e.bounces) ?? 0) : null,
  };
}

/** 累計として差分を取る項目 */
export const CUMULATIVE_FIELDS = Object.freeze(['sent', 'failed', 'duplicates']);
/** すでに窓で切られている項目（**差分を取らない**） */
export const WINDOW_FIELDS = Object.freeze(['complaints', 'unsubscribes', 'bounces']);
export const OUTCOME_FIELDS = Object.freeze([...CUMULATIVE_FIELDS, ...WINDOW_FIELDS]);

/**
 * 前バッチの起点（baseline）からの**増分**。
 *
 * ⚠️ 累計（送信・失敗・二重）が減ることはあり得る（台帳の掃除・再計算）。
 *    **差分は 0 で下げ止める**（減少を異常にしない）。
 * ⚠️ どれか 1 つでも読めなければ `ok: false`（呼び出し側が fail closed）。
 */
export function diffOutcomeSnapshot(baseline, current) {
  const b = baseline && typeof baseline === 'object' ? baseline : null;
  const c = current && typeof current === 'object' ? current : null;
  const counts = {};
  const missing = [];
  for (const f of CUMULATIVE_FIELDS) {
    const now = c ? num(c[f]) : null;
    const before = b ? num(b[f]) : null;
    if (now === null || before === null) { counts[f] = null; missing.push(f); continue; }
    counts[f] = Math.max(0, now - before);
  }
  for (const f of WINDOW_FIELDS) {
    // ⚠️ 台帳を窓（バッチ開始 → いま）で切って数えた**そのもの**。差分を取らない
    //    （差分にすると、古い登録者の新イベントや同一人の複数イベントを落とす）
    const v = c ? num(c[f]) : null;
    if (v === null) { counts[f] = null; missing.push(f); continue; }
    counts[f] = Math.max(0, v);
  }
  return { ok: missing.length === 0, counts, missing };
}

/** 比較できる起点を持っているか（最初のバッチは持たない） */
export function hasOutcomeBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object') return false;
  return OUTCOME_FIELDS.some((f) => num(baseline[f]) !== null);
}

/** 状態へ保存する形（**件数だけ**。アドレスも recordId も入れない） */
export function toStoredOutcome(snapshot, nowMs) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const out = { atMs: Number(nowMs) || null };
  for (const f of OUTCOME_FIELDS) out[f] = num(s[f]);
  return out;
}

export default diffOutcomeSnapshot;
