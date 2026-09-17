/**
 * prospectLedgerConsistency.js — **Redis の予約と Airtable の配信行が食い違っている人を数える**（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-17 本番実測）
 *
 * `campaign-discount-free` の tick が毎回こう出る:
 *
 *   `abort: window_needs_full_reload` / `reason: zero_sendable_in_window` /
 *   `step: 2` / **`alreadyQueued: 97`**
 *
 * `alreadyQueued` は「送ろうとしたが**既に queued / sent だった**人数」で、
 * その判定は `fetchActiveDeliveryKeys`（**Airtable の `CampaignDeliveries`**）で行っている。
 *
 * ところが **prospect は Airtable に 1 行も書かない**（2026-08-27 MK 確定。
 * レコード上限を超過したため、prospect の冪等性は Redis の集合が担う）。
 * つまり prospect について Airtable に active な行があるなら、それは
 * **移行前に Customers だったころの古い行**か、**送り切らずに残った行**しかない。
 *
 * このとき起きること:
 *
 * | 見る場所 | その人の状態 |
 * |---|---|
 * | Redis（prospect の正本）| step2 の鍵が**無い** → **まだ送っていない = due** |
 * | Airtable（判定に使っている）| step2 の行が `queued` / `sent` → **送らない** |
 *
 * → **永久に積まれない。** しかも #569 の「窓の中だけで次 step へ進まない」規則により、
 *    その窓は毎回 0 人になり、**毎回 full-index へ落ちる**（順番の半分が空振りになる）。
 *
 * ## ここで決めること
 *
 * **数えるだけ。** 直さない・消さない・送らない。
 * 「正常な履歴」なのか「Redis と Airtable の不整合」なのかを**件数で確定**する。
 *
 * ⚠️ アドレス・`DeliveryKey`・recordId は**1 つも受け取らないし返さない**。
 *    呼び出し側が鍵の集合を渡し、ここは**数**だけを返す。
 */

/** `CampaignDeliveries` の `Status` を数えるときの区分 */
export const LEDGER_STATUS = Object.freeze({
  QUEUED: 'queued',
  SENT: 'sent',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  /** 上のどれでもない値（スキーマが増えたときに黙って落とさない） */
  OTHER: 'other',
  /** そもそも行が無い */
  NONE: 'none',
});

/**
 * `Status` を区分へ寄せる。
 *
 * ⚠️ **知らない値を `none` に寄せない。** 「行が無い」と「読めたが知らない値」は別物で、
 *    混ぜると「Airtable に無いから積んでよい」と誤って判断しうる。
 */
export function normalizeLedgerStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return LEDGER_STATUS.NONE;
  if (s === LEDGER_STATUS.QUEUED) return LEDGER_STATUS.QUEUED;
  if (s === LEDGER_STATUS.SENT) return LEDGER_STATUS.SENT;
  if (s === LEDGER_STATUS.FAILED) return LEDGER_STATUS.FAILED;
  if (s === LEDGER_STATUS.CANCELLED) return LEDGER_STATUS.CANCELLED;
  return LEDGER_STATUS.OTHER;
}

/**
 * **送信可否の判定で「もう積んである」とみなされる区分**。
 *
 * `cron-campaign-sequence` の `fetchActiveDeliveryKeys` と**同じ判定**にそろえる
 * （`queued` / `sent` だけが active。`failed` / `cancelled` は積み直してよい）。
 * ここがズレると診断が実態とズレるので、変えるときは両方を一緒に変えること。
 */
export const ACTIVE_STATUSES = Object.freeze([LEDGER_STATUS.QUEUED, LEDGER_STATUS.SENT]);

export const isActiveStatus = (status) => ACTIVE_STATUSES.includes(status);

/**
 * 鍵ごとに「Redis にあるか」「Airtable の Status は何か」を突き合わせて**数える**。
 *
 * @param {{
 *   keys: string[],                  // 判定対象（同じ step の鍵。重複は 1 つとして数える）
 *   redisPresent: Set<string>,       // Redis の予約集合に入っていた鍵
 *   airtableStatusByKey: Map<string,string>, // Airtable にあった鍵 → Status（無い鍵は入れない）
 * }} input
 * @returns {{
 *   total: number,
 *   byStatus: Record<string, number>,
 *   active: number,
 *   activeInRedis: number,
 *   activeNotInRedis: number,
 *   inactiveInRedis: number,
 *   redisOnly: number,
 *   neither: number,
 *   balanced: boolean,
 * }}
 */
export function classifyLedgerConsistency({ keys, redisPresent, airtableStatusByKey } = {}) {
  const uniq = [...new Set((Array.isArray(keys) ? keys : []).map(String).filter(Boolean))];
  const inRedis = redisPresent instanceof Set ? redisPresent : new Set();
  const byKey = airtableStatusByKey instanceof Map ? airtableStatusByKey : new Map();

  const byStatus = {
    [LEDGER_STATUS.QUEUED]: 0,
    [LEDGER_STATUS.SENT]: 0,
    [LEDGER_STATUS.FAILED]: 0,
    [LEDGER_STATUS.CANCELLED]: 0,
    [LEDGER_STATUS.OTHER]: 0,
    [LEDGER_STATUS.NONE]: 0,
  };
  const out = {
    total: uniq.length,
    byStatus,
    active: 0,
    /** Airtable が active で Redis にもある（＝素直に送信済み） */
    activeInRedis: 0,
    /**
     * ⚠️ **これが本件の数**。Airtable は `queued` / `sent` なのに Redis に予約が無い。
     *    Redis から見れば未送信なので due になり、Airtable から見れば active なので積まれない。
     *    **その人は永久に積まれない。**
     */
    activeNotInRedis: 0,
    /** Airtable は failed / cancelled / 行なしだが Redis にはある（Redis が先に進んでいる） */
    inactiveInRedis: 0,
    /** Airtable に行が無く Redis にはある（**prospect の正常形**） */
    redisOnly: 0,
    /** どちらにも無い（純粋にこれから送る人） */
    neither: 0,
  };

  for (const k of uniq) {
    const status = byKey.has(k) ? normalizeLedgerStatus(byKey.get(k)) : LEDGER_STATUS.NONE;
    byStatus[status] = (byStatus[status] || 0) + 1;
    const present = inRedis.has(k);
    if (isActiveStatus(status)) {
      out.active += 1;
      if (present) out.activeInRedis += 1;
      else out.activeNotInRedis += 1;
      continue;
    }
    // ここから先は Airtable 的には「積み直してよい」状態
    if (present) {
      out.inactiveInRedis += 1;
      if (status === LEDGER_STATUS.NONE) out.redisOnly += 1;
    } else {
      out.neither += 1;
    }
  }

  // 数え方の検算（崩れていたら「確定した」と言わない）
  out.balanced = out.total === out.activeInRedis + out.activeNotInRedis
    + out.inactiveInRedis + out.neither;
  return out;
}

/**
 * prospect レコードの `delivered` 累計の分布（打ち切り 10 通の分母が入っているか）。
 *
 * ⚠️ アドレスは受け取らない。数値の配列だけ。
 */
export function deliveredHistogram(counts) {
  const hist = {};
  let max = 0;
  for (const raw of Array.isArray(counts) ? counts : []) {
    /**
     * ⚠️ `null` / `undefined` / `''` を `Number()` に通すと **0 になる**
     *    （＝「まだ 1 通も届いていない人」が水増しされる）。**欠測は 0 ではない。**
     */
    if (raw === null || raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) continue;
    const k = String(Math.floor(n));
    hist[k] = (hist[k] || 0) + 1;
    if (n > max) max = Math.floor(n);
  }
  return { histogram: hist, max };
}

/** `ScheduledEmails` の `Status` を数えるときの区分（送信ジョブ側） */
export const JOB_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  OTHER: 'OTHER',
});

export function normalizeJobStatus(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === JOB_STATUS.PENDING) return JOB_STATUS.PENDING;
  if (s === JOB_STATUS.SENT) return JOB_STATUS.SENT;
  if (s === JOB_STATUS.FAILED) return JOB_STATUS.FAILED;
  if (s === JOB_STATUS.CANCELLED) return JOB_STATUS.CANCELLED;
  return JOB_STATUS.OTHER;
}

/**
 * ジョブの Status を数える。**打ち切りを成功として扱わない。**
 *
 * @param {{statuses: string[], truncated?: boolean}} input
 * @returns {{complete: boolean, counts: Record<string, number>, total: number}}
 */
export function summarizeJobStatuses({ statuses, truncated = false } = {}) {
  const counts = {
    [JOB_STATUS.PENDING]: 0,
    [JOB_STATUS.SENT]: 0,
    [JOB_STATUS.FAILED]: 0,
    [JOB_STATUS.CANCELLED]: 0,
    [JOB_STATUS.OTHER]: 0,
  };
  let total = 0;
  for (const s of Array.isArray(statuses) ? statuses : []) {
    counts[normalizeJobStatus(s)] += 1;
    total += 1;
  }
  /**
   * ⚠️ **読み切れていないなら `complete: false`。** 途中までの集計を
   *    「PENDING は 0 件でした」と読めてしまう形で返してはいけない。
   */
  return { complete: truncated !== true, counts, total };
}

/**
 * 窓を積み上げた合計を作る（**読み切れた窓だけ**を足す）。
 *
 * ⚠️ 1 つでも読み切れていない窓があれば `complete: false`。
 *    呼び出し側はそれを「確定した件数」として扱ってはいけない。
 */
export function mergeWindowCounts(windows) {
  const list = Array.isArray(windows) ? windows : [];
  const sum = {
    total: 0, active: 0, activeInRedis: 0, activeNotInRedis: 0,
    inactiveInRedis: 0, redisOnly: 0, neither: 0,
  };
  const byStatus = {};
  let complete = list.length > 0;
  for (const w of list) {
    if (!w || w.ok !== true) { complete = false; continue; }
    for (const k of Object.keys(sum)) sum[k] += Number(w.counts?.[k]) || 0;
    for (const [k, v] of Object.entries(w.counts?.byStatus || {})) {
      byStatus[k] = (byStatus[k] || 0) + (Number(v) || 0);
    }
    if (w.counts && w.counts.balanced === false) complete = false;
  }
  return { complete, ...sum, byStatus };
}

export default classifyLedgerConsistency;
