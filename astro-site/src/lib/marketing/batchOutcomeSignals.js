/**
 * batchOutcomeSignals.js — 前バッチで**実際に起きたこと**だけを数える（純粋・I/O なし）
 *
 * ── なぜ要るか（2 度の誤検知）────────────────────────────────
 * バッチ健全性の入力に `action=sequence` の `byStopReason` を使っていた。これは
 * **「いま候補を除外する理由」＝ 現在の状態**であって、前バッチで起きた出来事ではない。
 *
 *   `provider_suppressed` … 配信基盤の停止リストに**載っている**（過去いつのことでもよい）
 *   `not_sendable`        … 配信停止・バウンス・停止アカウント等の**現在状態**
 *   `soft_bounce`         … ソフトバウンスの**履歴あり**
 *
 * 1 回目の誤検知（累積をそのまま渡す）は「元から居る 1 名」で永久停止した。
 * 2 回目（累積の差分）も同じく誤る: 展開では母集団が 1 バッチ 500 名ずつ増えるので、
 * **前から停止リストに載っていた人が母集団へ入るだけで差分が増える**。
 *
 * ── 正しい source（既存の正本）──────────────────────────────
 * bounce / spam report / unsubscribe の正本は **`EmailBlacklist`**
 * （`sendgrid-webhook.js` が Event Webhook から書く唯一の経路）。
 * ここには**イベントが起きたときにだけ行が増える**ので、母集団が増えても増えない。
 *
 *   `BounceType: 'spam'`                        → 苦情（spam report）
 *   `BounceType: 'unsubscribe'`                 → 配信停止
 *   `BounceType: 'hard' | 'blocked' | 'dropped'`→ ハードバウンス相当
 *   `BounceType: 'soft'`                        → ソフトバウンス（**ハードとして数えない**）
 *
 * 送信・失敗は**ジョブ台帳**（`ScheduledEmails` の `sentCount` / `failedCount`）が正本で、
 * これは前バッチの送信でしか増えない。二重送信は **DeliveryKey** が構造的に防ぎ、
 * 送信経路が `already_delivered` として弾いた数を duplicate として受け取る。
 *
 * ⚠️ ここは**数えるだけ**。しきい値の判断は `batchHealth.js`（既存契約・変更しない）。
 * ⚠️ 読めない指標は `null`（0 と書かない）。呼び出し側が fail closed する。
 */

/** `EmailBlacklist.BounceType` → 健全性の分類 */
export const BLACKLIST_KIND = Object.freeze({
  spam: 'complaints',
  unsubscribe: 'unsubscribes',
  hard: 'bounces',
  blocked: 'bounces',
  dropped: 'bounces',
  // soft は**ハードバウンスとして数えない**（既存しきい値はハード想定）
  soft: 'softBounces',
});

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v) => String(v ?? '').trim().toLowerCase();

/**
 * `EmailBlacklist` の**最近の行**を分類して数える。
 *
 * ⚠️ 渡すのは「直近の窓（当日 + 前日）」に絞った行。全件走査はしない。
 * ⚠️ 行が読めなかった（`records` が配列でない）ときは **null**（0 と書かない）。
 *
 * @param {Array<{fields?: object}>} records
 * @returns {{complaints: number, unsubscribes: number, bounces: number,
 *            softBounces: number, rows: number}|null}
 */
export function summarizeBlacklistWindow(records) {
  if (!Array.isArray(records)) return null;
  const out = { complaints: 0, unsubscribes: 0, bounces: 0, softBounces: 0, rows: 0 };
  for (const r of records) {
    const f = (r && r.fields) || r || {};
    const kind = BLACKLIST_KIND[str(f.BounceType)];
    out.rows += 1;
    if (!kind) continue;             // 未知の種別は**どれにも足さない**（推測しない）
    out[kind] += 1;
  }
  return out;
}

/**
 * 前バッチの健全性入力を 1 つにまとめる（**すべて「起きた回数」**）。
 *
 * @param {{jobsSent: number|null, jobsFailed: number|null,
 *          duplicates: number|null, blacklist: object|null}} input
 */
export function captureOutcomeSnapshot({ jobsSent, jobsFailed, duplicates, blacklist } = {}) {
  const b = blacklist && typeof blacklist === 'object' ? blacklist : null;
  return {
    sent: num(jobsSent),
    failed: num(jobsFailed),
    duplicates: num(duplicates),
    complaints: b ? (num(b.complaints) ?? 0) : null,
    unsubscribes: b ? (num(b.unsubscribes) ?? 0) : null,
    bounces: b ? (num(b.bounces) ?? 0) : null,
  };
}

/** 差分を取る項目（**すべて単調増加の累計**） */
export const OUTCOME_FIELDS = Object.freeze([
  'sent', 'failed', 'duplicates', 'complaints', 'unsubscribes', 'bounces',
]);

/**
 * 前バッチの起点（baseline）からの**増分**。
 *
 * ⚠️ 日付が変わると `EmailBlacklist` の窓（当日 + 前日）から古い行が外れ、
 *    累計が減ることがある。**差分は 0 で下げ止める**（減少を異常にしない）。
 * ⚠️ どれか 1 つでも読めなければ `ok: false`（呼び出し側が fail closed）。
 */
export function diffOutcomeSnapshot(baseline, current) {
  const b = baseline && typeof baseline === 'object' ? baseline : null;
  const c = current && typeof current === 'object' ? current : null;
  const counts = {};
  const missing = [];
  for (const f of OUTCOME_FIELDS) {
    const now = c ? num(c[f]) : null;
    const before = b ? num(b[f]) : null;
    if (now === null || before === null) { counts[f] = null; missing.push(f); continue; }
    counts[f] = Math.max(0, now - before);
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

/**
 * `EmailBlacklist` を読むときの窓（**当日 + 前日**）。
 * バッチが日付をまたいでも、直前バッチのイベントが窓から外れないようにする。
 *
 * @returns {string} Airtable の filterByFormula
 */
export function blacklistWindowFormula(nowMs, days = 2) {
  const d = Math.max(1, Math.floor(Number(days) || 2));
  // AddedAt は日付のみ（YYYY-MM-DD）。直近 d 日ぶんに限定する
  return `IS_AFTER({AddedAt}, DATEADD(TODAY(), -${d}, 'days'))`;
}

export default diffOutcomeSnapshot;
