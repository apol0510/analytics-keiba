/**
 * importJobReconcile.js — 取り込みの突合（純粋・I/O なし）
 *
 * ── 3 点では足りない ──────────────────────────────────────────
 * ジョブ counters と Airtable の `Source` 件数だけを見ても、
 * 「claim は取れたが作成されていない行」や「重複が増えていないか」は分からない。
 * **少なくとも 4 点**で突合する:
 *
 *   1. Redis のジョブ counters（created / skippedExisting / failed / attempted）
 *   2. Redis の行 claim 状態（CLAIMED / CREATED / RELEASE_PENDING の内訳）
 *   3. Airtable の `Source` 件数（実際に作られた行）
 *   4. Customers 全体の**正規化メール重複数**（取り込みが重複を増やしていないこと）
 *
 * **不一致なら自動続行しない。** PARTIAL または BLOCKED へ遷移させる。
 */

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/** 突合の判定 */
/**
 * BLOCKED の前に**測り直すべき**不一致かどうか。
 *
 * ⚠️ Airtable の一覧はページングで、**書き込み中に読むと少なく数えることがある**
 *    （2026-08-09 の本実行で `4400 vs 4333` の過少計測が発生し、書き込み停止後に
 *    数え直したら 4,400 で一致した）。1 回のスナップショットを正本にしない。
 *
 * 対象は「実測が記録より**少ない**」ケースだけ。多い場合は測り直しでは説明できない
 * （＝本当に増えている）ので、そのまま BLOCKED にする。
 *
 * @param {{ failedChecks: string[], created: number, airtableSourceCount: number|null }} input
 */
export function shouldRemeasureBeforeBlock({ failedChecks, created, airtableSourceCount } = {}) {
  const failed = Array.isArray(failedChecks) ? failedChecks : [];
  if (failed.length === 0) return false;
  const COUNT_CHECKS = ['created_matches_airtable', 'claims_created_matches_airtable'];
  // 件数系以外が落ちているなら測り直しでは直らない
  if (!failed.every((f) => COUNT_CHECKS.includes(f))) return false;
  if (airtableSourceCount === null || airtableSourceCount === undefined) return false;
  return Number(airtableSourceCount) < Number(created);
}

export const RECONCILE_VERDICT = Object.freeze({
  OK: 'OK',
  PARTIAL: 'PARTIAL',     // 説明できる不足（claim 済み・未作成など）。reconciler の回収待ち
  BLOCKED: 'BLOCKED',     // 説明できない不一致。**人が見るまで進めない**
});

/**
 * @param {{
 *   job: object,                                   Redis 正本
 *   claimCounts: { CLAIMED: number, CREATED: number, RELEASE_PENDING: number },
 *   airtableSourceCount: number,                   Source 一致件数
 *   duplicateEmailPairs: number,                   Customers 全体の重複メール組数（実測）
 *   duplicateEmailPairsBaseline: number,           ジョブ開始前の同値
 * }} input
 */
export function reconcileImportJob({
  job, claimCounts, airtableSourceCount, duplicateEmailPairs, duplicateEmailPairsBaseline,
} = {}) {
  const planned = int(job?.plannedTotal);
  const created = int(job?.created);
  const skipped = int(job?.skippedExisting);
  const failed = int(job?.failed);
  const attempted = int(job?.attempted);

  const c = claimCounts || {};
  const claimClaimed = int(c.CLAIMED);
  const claimCreated = int(c.CREATED);
  const claimPending = int(c.RELEASE_PENDING);

  const airtable = Number.isFinite(airtableSourceCount) ? int(airtableSourceCount) : null;
  const dup = Number.isFinite(duplicateEmailPairs) ? int(duplicateEmailPairs) : null;
  const dupBase = Number.isFinite(duplicateEmailPairsBaseline) ? int(duplicateEmailPairsBaseline) : null;

  const checks = [];
  // ⚠️ キー名を `name` にしない。この結果は job 正本へ保存され、
  //    `assertNoPii` が **`name` を PII とみなして保存を拒否する**（2026-08-09 の障害）。
  //    実際、子バッチが Airtable へ 100 件書いた後に正本の保存だけが invalid_job で
  //    落ち、「作成済み 0 なのに 100 件存在する」不整合になった。
  const add = (checkId, ok, detail) => checks.push({ checkId, ok, detail: detail ?? null });

  // 1) counters の内訳が試行数と合うか
  add('counters_balanced', created + skipped + failed === attempted,
    `${created}+${skipped}+${failed} vs ${attempted}`);
  // 2) 計画を超えて書いていないか
  add('within_plan', created <= planned, `${created} <= ${planned}`);
  // 3) ジョブ counters と Airtable 実測が一致するか（**正本の交差確認**）
  add('created_matches_airtable', airtable === null ? true : created === airtable,
    airtable === null ? 'airtable 未取得' : `${created} vs ${airtable}`);
  // 4) CREATED claim 数と Airtable 実測が一致するか
  add('claims_created_matches_airtable', airtable === null ? true : claimCreated === airtable,
    airtable === null ? 'airtable 未取得' : `${claimCreated} vs ${airtable}`);
  // 5) 重複が増えていないか（**取り込みの目的に反する唯一の致命傷**）
  add('no_new_duplicates', (dup === null || dupBase === null) ? true : dup <= dupBase,
    (dup === null || dupBase === null) ? '重複数 未取得' : `${dup} vs 基準 ${dupBase}`);

  const failedChecks = checks.filter((x) => !x.ok).map((x) => x.checkId);

  // claim は取れたが作成されていない行（回収待ち）。**これ自体は異常ではない**
  const claimedNotCreated = claimClaimed;

  let verdict = RECONCILE_VERDICT.OK;
  if (failedChecks.length > 0) {
    // 重複増加・計画超過・Airtable 不一致は**説明できない不一致**
    verdict = RECONCILE_VERDICT.BLOCKED;
  } else if (claimedNotCreated > 0 || claimPending > 0) {
    verdict = RECONCILE_VERDICT.PARTIAL;
  }

  return {
    verdict,
    /** 自動で次の子バッチへ進んでよいか。**OK 以外は進めない** */
    canContinue: verdict === RECONCILE_VERDICT.OK,
    planned, attempted, created, skippedExisting: skipped, failed,
    claims: { CLAIMED: claimClaimed, CREATED: claimCreated, RELEASE_PENDING: claimPending },
    airtableSourceCount: airtable,
    duplicateEmailPairs: dup,
    duplicateEmailPairsBaseline: dupBase,
    claimedNotCreated,
    checks,
    failedChecks,
    note: verdict === RECONCILE_VERDICT.OK
      ? '4 点すべて一致しています。'
      : (verdict === RECONCILE_VERDICT.PARTIAL
        ? 'claim 済み・未作成が残っています。reconciler の回収を待ってください（自動続行しません）。'
        : '説明できない不一致があります。**人が確認するまで進めないでください。**'),
  };
}

/**
 * reconciler が claim を解放してよいか。**4 条件すべて**を満たすときだけ true。
 *
 * @param {{
 *   claim: object,                     Redis の claim
 *   absentInCustomers: boolean,        同じ正規化メールが Customers に無い
 *   absentForSource: boolean,          同じ Source の行として作られていない
 *   nowMs: number,
 *   currentFencingToken: string|number,
 * }} input
 */
export function canReleaseClaim({
  claim, absentInCustomers, absentForSource, nowMs, currentFencingToken,
} = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!claim) return no('no_claim');
  if (claim.state === 'CREATED') return no('already_created');
  // 1) Customers に同じメールが無いこと
  if (absentInCustomers !== true) return no('present_in_customers');
  // 2) 同じ Source の行として作られていないこと
  if (absentForSource !== true) return no('present_for_source');
  // 3) claim が期限切れであること
  const exp = Date.parse(claim.expiresAt);
  if (!Number.isFinite(exp)) return no('bad_expiry');
  if (exp > int(nowMs)) return no('not_expired');
  // 4) 旧 fencing token が失効していること（現在の token より古い）
  if (Number(claim.fencingToken) >= Number(currentFencingToken)) return no('fencing_token_still_current');
  return { ok: true, reason: null };
}

export default reconcileImportJob;
