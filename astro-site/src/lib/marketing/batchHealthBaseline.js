/**
 * batchHealthBaseline.js — バッチ間の健全性を「**増えたぶん**」で見る（純粋・I/O なし）
 *
 * ── なぜ要るか（2026-08-17 の誤検知）────────────────────────────
 * 全コホートの展開を開始した直後、**1 tick 目で自動停止**した。
 * 理由は `complaints_detected`。しかし実際に苦情が起きたのではなく、
 * コホートの中に **配信基盤の停止リスト（provider suppression）に載っている人が 1 名**
 * ずっと居ただけだった。運転手はこれを「苦情 1 件」として渡していた。
 *
 *   `byStopReason.provider_suppressed` … **候補を除外した理由**（静的・累積）
 *   苦情・バウンス・配信停止        … **前のバッチで起きた出来事**（増分）
 *
 * この 2 つは別物で、静的な除外を増分として扱うと**永久に開始できない**
 * （0 件許容の苦情しきい値に、消えない 1 が常に当たる）。
 *
 * ── ここでやること ────────────────────────────────────────────
 * バッチを始めるたびに**スナップショット**（累積値）を控え、次のバッチの前に
 * **差分**を取る。差分＝そのバッチで新しく起きたこと。
 *
 * ⚠️ 累積値が読めない項目は差分も `null`（0 と書かない）。`canStartNextBatch` が
 *    「数えられない」として fail closed する。
 * ⚠️ 累積が減る（台帳の再計算・掃除）ことはあり得るので、差分は **0 で下げ止め**る。
 */

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** スナップショットに載せる項目（**累積値**） */
export const HEALTH_FIELDS = Object.freeze([
  'sent', 'failed', 'duplicates', 'bounces', 'complaints', 'unsubscribes',
]);

/**
 * いまの累積値を 1 つにまとめる。
 *
 * @param {{jobsSent: number|null, jobsFailed: number|null, dueSummary: object|null}} input
 *   `jobsSent` / `jobsFailed` … ジョブ台帳の累計（送信の正本）
 *   `dueSummary` … `action=sequence` の集計（**停止理由は累積の内訳**）
 */
export function captureHealthSnapshot({ jobsSent, jobsFailed, dueSummary } = {}) {
  const s = dueSummary && typeof dueSummary === 'object' ? dueSummary : null;
  const stop = s && typeof s.byStopReason === 'object' && s.byStopReason ? s.byStopReason : null;
  return {
    sent: num(jobsSent),
    failed: num(jobsFailed),
    duplicates: s ? (num(s.duplicates) ?? 0) : null,
    // 配信基盤の停止リスト・配信停止・バウンスは**累積の人数**として控える
    bounces: stop ? (num(stop.soft_bounce) ?? 0) : null,
    complaints: stop ? (num(stop.provider_suppressed) ?? 0) : null,
    unsubscribes: stop ? (num(stop.not_sendable) ?? 0) : null,
  };
}

/**
 * 前のバッチからの**増分**を出す。
 *
 * @returns {{ok: boolean, counts: object, missing: string[]}}
 *   `ok: false` は「差分を出せない」（`canStartNextBatch` へ null を渡して止めさせる）
 */
export function diffHealthSnapshot(baseline, current) {
  const b = baseline && typeof baseline === 'object' ? baseline : null;
  const c = current && typeof current === 'object' ? current : null;
  const counts = {};
  const missing = [];
  for (const f of HEALTH_FIELDS) {
    const now = c ? num(c[f]) : null;
    const before = b ? num(b[f]) : null;
    if (now === null || before === null) {
      counts[f] = null;
      missing.push(f);
      continue;
    }
    // 累積が減ることもある（掃除・再計算）。**マイナスにはしない**
    counts[f] = Math.max(0, now - before);
  }
  return { ok: missing.length === 0, counts, missing };
}

/**
 * 最初のバッチ（比較相手が無い）かどうか。
 * ⚠️ ここで「異常なし」と決めつけない。**比較できないので健全性判定を行わない**だけ。
 *    最初のバッチは関所・1 日上限・kill switch など他の安全装置で守る。
 */
export function hasHealthBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object') return false;
  return HEALTH_FIELDS.some((f) => num(baseline[f]) !== null);
}

/** 状態に保存する形へ（**件数だけ**。PII は入らない） */
export function toStoredBaseline(snapshot, nowMs) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const out = { atMs: Number(nowMs) || null };
  for (const f of HEALTH_FIELDS) out[f] = num(s[f]);
  return out;
}

export default diffHealthSnapshot;
