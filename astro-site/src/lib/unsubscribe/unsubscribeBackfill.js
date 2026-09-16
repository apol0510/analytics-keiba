/**
 * unsubscribeBackfill.js — 旧 mailto 経路で届いた配信停止依頼の**一度きりの一括精算**（純粋・IO なし）
 *
 * ## これは何か（通常運用ではない）
 *
 * PR #558 が production へ published される前（**cutoff: 2026-09-16T14:56:15.220Z**）に
 * 送られたメールには、`List-Unsubscribe` に mailto が併記されていた。Apple Mail 等は
 * mailto を選ぶため、押した人の依頼は `unsubscribe@keiba.link` の受信箱に溜まり、
 * **AK 側には 1 ビットも反映されていない**。
 *
 * その積み残しを**一度だけ**まとめて停止へ反映し、旧 mailto 残件をゼロにしてクローズする。
 * **以後の通常運用はしない**（#558 の HTTPS ワンクリック経路だけが正規）。
 *
 * ## 設計の要点
 *
 * - 判定・書き込みは **#558 の正本をそのまま再利用**する。ここに 2 つ目の停止ロジックを作らない
 * - **dry-run が既定**。対象件数を先に確定してからでないと書かない
 * - **冪等**。既に停止済みの人は「変更なし」で数え、二重に書かない
 * - **fail closed**。読めない相手は「不明」に倒し、成功扱いにしない
 * - 生アドレスを**戻り値にもログにも出さない**（追跡は `emailTraceId` のハッシュだけ）
 * - 契約・権限・退会・決済系フィールドには**触れない**（触る先は #558 と同じ 2 つだけ）
 */

/** 旧方式の cutoff（#558 が production へ published された実測時刻）。 */
export const LEGACY_CUTOFF_ISO = '2026-09-16T14:56:15.220Z';

/** 1 回の実行で扱う上限（暴走防止）。 */
export const MAX_BACKFILL_TARGETS = 500;

/** 照合結果の区分。 */
export const TARGET_STATUS = Object.freeze({
  /** Customers に居て、既に配信停止済み */
  CUSTOMER_ALREADY: 'customer-already',
  /** Customers に居て、未反映 → 書く */
  CUSTOMER_PENDING: 'customer-pending',
  /** 見込み客に居て、既に抑止済み */
  PROSPECT_ALREADY: 'prospect-already',
  /** 見込み客に居て、未反映 → 書く */
  PROSPECT_PENDING: 'prospect-pending',
  /** どちらにも居ない（既に削除された等）*/
  NOT_FOUND: 'not-found',
  /** 読めなかった＝判定不能（**成功扱いにしない**）*/
  UNKNOWN: 'unknown',
});

/** 入力アドレスが弾かれた理由。 */
export const INPUT_REJECT = Object.freeze({
  INVALID: 'invalid-email',
  DUPLICATE: 'duplicate',
  OVER_LIMIT: 'over-limit',
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 入力リストを正規化する。**重複排除は小文字化した後**に行う
 * （同一人物から複数回届いているのが旧方式の常態）。
 *
 * @param {unknown} raw 受信箱から抽出したアドレスの配列
 * @returns {{emails: string[], rejected: Record<string, number>, received: number}}
 *   `rejected` は理由ごとの**件数だけ**（アドレスは返さない）
 */
export function normalizeBackfillInput(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const emails = [];
  const rejected = {};
  const bump = (r) => { rejected[r] = (rejected[r] || 0) + 1; };

  for (const item of list) {
    const e = String(item ?? '').trim().toLowerCase();
    if (!e || !EMAIL_RE.test(e)) { bump(INPUT_REJECT.INVALID); continue; }
    if (seen.has(e)) { bump(INPUT_REJECT.DUPLICATE); continue; }
    if (emails.length >= MAX_BACKFILL_TARGETS) { bump(INPUT_REJECT.OVER_LIMIT); continue; }
    seen.add(e);
    emails.push(e);
  }
  return { emails, rejected, received: list.length };
}

/**
 * 1 人ぶんの照合結果を区分へ落とす。
 *
 * @param {object} input
 * @param {'found'|'missing'|'unknown'} input.customer      Customers に居たか
 * @param {boolean|null} input.customerUnsubscribed          既に配信停止済みか
 * @param {'found'|'missing'|'unknown'} input.prospect       見込み客に居たか
 * @param {boolean|null} input.prospectSuppressed            既に抑止済みか
 * @returns {{statuses: string[], needsWrite: {customer: boolean, prospect: boolean}}}
 */
export function classifyBackfillTarget({
  customer, customerUnsubscribed, prospect, prospectSuppressed,
} = {}) {
  const statuses = [];
  const needsWrite = { customer: false, prospect: false };

  if (customer === 'found') {
    if (customerUnsubscribed === true) statuses.push(TARGET_STATUS.CUSTOMER_ALREADY);
    else { statuses.push(TARGET_STATUS.CUSTOMER_PENDING); needsWrite.customer = true; }
  } else if (customer === 'unknown') {
    statuses.push(TARGET_STATUS.UNKNOWN);
  }

  if (prospect === 'found') {
    if (prospectSuppressed === true) statuses.push(TARGET_STATUS.PROSPECT_ALREADY);
    else { statuses.push(TARGET_STATUS.PROSPECT_PENDING); needsWrite.prospect = true; }
  } else if (prospect === 'unknown') {
    if (!statuses.includes(TARGET_STATUS.UNKNOWN)) statuses.push(TARGET_STATUS.UNKNOWN);
  }

  // どちらにも居ない（かつ読めている）
  if (statuses.length === 0) statuses.push(TARGET_STATUS.NOT_FOUND);

  // ⚠️ 判定不能が混じる相手は**書かない**（fail closed）。
  //    片方が読めていないのに片方だけ書くと、どこまで進んだか分からなくなる
  if (statuses.includes(TARGET_STATUS.UNKNOWN)) {
    return { statuses, needsWrite: { customer: false, prospect: false } };
  }
  return { statuses, needsWrite };
}

/**
 * 照合結果を集計する。**アドレスは含めない**（PII を出さない）。
 *
 * @param {Array<{statuses: string[], needsWrite: {customer: boolean, prospect: boolean}}>} rows
 */
export function summarizeBackfillPlan(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const has = (r, s) => r.statuses.includes(s);

  const customerOnly = list.filter((r) =>
    (has(r, TARGET_STATUS.CUSTOMER_ALREADY) || has(r, TARGET_STATUS.CUSTOMER_PENDING))
    && !(has(r, TARGET_STATUS.PROSPECT_ALREADY) || has(r, TARGET_STATUS.PROSPECT_PENDING))).length;
  const prospectOnly = list.filter((r) =>
    (has(r, TARGET_STATUS.PROSPECT_ALREADY) || has(r, TARGET_STATUS.PROSPECT_PENDING))
    && !(has(r, TARGET_STATUS.CUSTOMER_ALREADY) || has(r, TARGET_STATUS.CUSTOMER_PENDING))).length;
  const both = list.filter((r) =>
    (has(r, TARGET_STATUS.CUSTOMER_ALREADY) || has(r, TARGET_STATUS.CUSTOMER_PENDING))
    && (has(r, TARGET_STATUS.PROSPECT_ALREADY) || has(r, TARGET_STATUS.PROSPECT_PENDING))).length;

  const needsWrite = list.filter((r) => r.needsWrite.customer || r.needsWrite.prospect).length;
  const alreadyStopped = list.filter((r) =>
    !r.needsWrite.customer && !r.needsWrite.prospect
    && (has(r, TARGET_STATUS.CUSTOMER_ALREADY) || has(r, TARGET_STATUS.PROSPECT_ALREADY))).length;

  return {
    unique: list.length,
    alreadyStopped,
    needsWrite,
    customerOnly,
    prospectOnly,
    both,
    notFound: list.filter((r) => has(r, TARGET_STATUS.NOT_FOUND)).length,
    unknown: list.filter((r) => has(r, TARGET_STATUS.UNKNOWN)).length,
    writes: {
      customer: list.filter((r) => r.needsWrite.customer).length,
      prospect: list.filter((r) => r.needsWrite.prospect).length,
    },
  };
}

/**
 * 実行してよいかの最終判定。**fail closed**。
 *
 * @param {object} input
 * @param {boolean} input.dryRun
 * @param {number} input.needsWrite       書き込みが要る人数
 * @param {number} input.expectedCount    承認時に確定した人数（食い違ったら実行しない）
 * @returns {{ok: boolean, reason: string|null}}
 */
export function decideBackfillExecution({ dryRun, needsWrite, expectedCount } = {}) {
  if (dryRun) return { ok: true, reason: null };
  if (!Number.isInteger(expectedCount)) return { ok: false, reason: 'expected-count-required' };
  // ⚠️ 承認した人数と実行時の人数が違えば止める。
  //    「承認後に対象が増えていた」を素通りさせない（承認範囲超過の再発防止）
  if (expectedCount !== needsWrite) return { ok: false, reason: 'expected-count-mismatch' };
  if (needsWrite === 0) return { ok: false, reason: 'nothing-to-do' };
  return { ok: true, reason: null };
}
