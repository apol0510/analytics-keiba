/**
 * drmAllowlistWindow.js — 許可リストの効きを**窓を刻んで**確かめる（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 2026-09-14 の事故（承認 16 名に対し Recipients 50 / SentCount 46）の直しは
 * 「最終 recipient 集合を許可リストで縛る」こと。それが効いているかを
 * **実送信 0 のまま**本番で確かめたいが、下見は本番 tick と同じ読み取りをするため
 * 母数（prospect 索引 約 12,000）を一度に読むと同期 Function に収まらない
 * （2026-09-15 に `drmEntryAllowlistCheck` で **504** を実測）。
 *
 * そこで `sequenceTickPreview` と**同じ窓契約**
 * （`scope` / `offset` / `limit` / `digest` / `ledgerOffset` / `scanPages`）で刻む。
 *
 * ── 合否の考え方（ここが肝）──────────────────────────────────
 * ⚠️ **窓ごとの人数を単純加算して判定しない。**
 *    同じ許可リスト対象は窓をまたいで何度も観測され得るので、足すと意味のない数になる。
 *    見るのは「**固定した planner の集合から外へ出ていないか**」だけ:
 *
 *      ① `plannerDigest` が全窓で同じ（母集団の前提が動いていない）
 *      ② どの窓でも「許可リスト外の残り」が 0
 *      ③ どの窓でも最終対象の prospect が 0
 *      ④ どの窓でも最終人数が `plannerCount` 以下
 *
 *    ①〜④ が全窓で成り立ち、かつ窓を読み切ったときだけ「効いている」と言える。
 *
 * ⚠️ **recordId もアドレスも外へ出さない。** 集合の同一性は digest だけで見る。
 */
import { createHash } from 'node:crypto';

const str = (v) => String(v ?? '').trim();
const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** 窓が壊れている / 続けてはいけない理由（固定コード） */
export const WINDOW_FAIL = Object.freeze({
  /** planner の集合が窓の途中で変わった（最初からやり直す） */
  PLANNER_CHANGED: 'planner_changed',
  /** prospect 索引が読んでいる最中に変わった（最初からやり直す） */
  PROSPECT_INDEX_CHANGED: 'prospect_index_changed',
  /** 許可リストの外が最終集合に残っていた（**これが出たら直っていない**） */
  OUTSIDE_ALLOWLIST: 'recipient_outside_allowlist',
  /** 最終集合に prospect が残っていた */
  PROSPECT_IN_FINAL: 'prospect_in_final',
  /** 最終人数が planner を超えた */
  OVER_PLANNER: 'final_over_planner',
});

/** 指紋の区切り（recordId に現れない文字） */
const SEP = '|';

/**
 * recordId の集合を **PII を出さない指紋**にする。
 *
 * ⚠️ 並び順で変わってはいけない（同じ集合なら同じ指紋）。**整列してから**畳む。
 * ⚠️ 重複は 1 つに畳む（数え方のブレを指紋に混ぜない）。
 * ⚠️ 空集合には指紋を作らない（`null`）。「誰も居ない」と「まだ数えていない」を混ぜない。
 * ⚠️ 返すのは指紋だけ。**recordId そのものは応答へ出さない**。
 */
export function digestRecordIds(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(str).filter(Boolean))].sort();
  if (list.length === 0) return null;
  const h = createHash('sha256');
  h.update(`v1${SEP}${list.length}${SEP}`);
  for (const id of list) { h.update(id); h.update(SEP); }
  return h.digest('hex');
}

/**
 * planner の集合が最初の窓から動いていないか。
 *
 * ⚠️ **数だけ一致しても通さない。** 人が入れ替わっても数は同じになり得る。
 *    指紋まで一致して初めて「同じ集合」と言える。
 */
export function assertPlannerStable({ expected, current } = {}) {
  const e = expected && typeof expected === 'object' ? expected : null;
  // 1 窓目は比較相手が無い（これが基準になる）
  if (!e || (e.count === undefined && e.digest === undefined)) return { ok: true, first: true };
  const sameCount = int(e.count) === int(current && current.count);
  const sameDigest = str(e.digest) === str(current && current.digest);
  if (sameCount && sameDigest) return { ok: true, first: false };
  return {
    ok: false, first: false, reason: WINDOW_FAIL.PLANNER_CHANGED,
    expected: { count: int(e.count), digest: str(e.digest) || null },
    got: { count: int(current && current.count), digest: str(current && current.digest) || null },
  };
}

/**
 * 1 窓ぶんの合否。**数えるのではなく、はみ出していないかを見る**。
 *
 * @param {{plannerCount: number, finalRecipients: number, outsideAllowlist: number,
 *          prospectInFinal: number, prospectSkipped: string|null}} w
 */
export function judgeWindow(w = {}) {
  const violations = [];
  const plannerCount = int(w.plannerCount) ?? 0;
  const finalRecipients = int(w.finalRecipients) ?? 0;
  const outside = int(w.outsideAllowlist) ?? 0;
  const prospect = int(w.prospectInFinal) ?? 0;

  // prospect 索引が変わったら**続けない**（読み飛ばした窓があるまま合格にしない）
  if (str(w.prospectSkipped) === WINDOW_FAIL.PROSPECT_INDEX_CHANGED) {
    violations.push(WINDOW_FAIL.PROSPECT_INDEX_CHANGED);
  }
  if (outside > 0) violations.push(WINDOW_FAIL.OUTSIDE_ALLOWLIST);
  if (prospect > 0) violations.push(WINDOW_FAIL.PROSPECT_IN_FINAL);
  if (finalRecipients > plannerCount) violations.push(WINDOW_FAIL.OVER_PLANNER);

  return { ok: violations.length === 0, violations };
}

/** 窓をまたいだ積み上げの初期値 */
export function emptyWindowRun() {
  return {
    windows: 0,
    /** 固定された前提（1 窓目で決まる） */
    planner: null,
    /** ⚠️ 人数は**足さない**。いちばん多かった窓だけを覚える */
    maxFinalInWindow: 0,
    violations: [],
    /** 窓を読み切ったか（`nextOffset` / `nextLedgerOffset` が両方 null） */
    complete: false,
  };
}

/**
 * 1 窓ぶんを積む。**finalRecipients は加算しない**（同じ人が別の窓でも観測される）。
 *
 * @param {object} acc `emptyWindowRun()` の戻り、または前回の戻り
 * @param {{planner: {count, digest}, finalRecipients: number, verdict: object,
 *          done: boolean}} w
 */
export function mergeWindowRun(acc, w = {}) {
  const a = acc && typeof acc === 'object' ? acc : emptyWindowRun();
  const verdict = w.verdict && typeof w.verdict === 'object' ? w.verdict : { ok: true, violations: [] };
  const stable = assertPlannerStable({ expected: a.planner, current: w.planner });
  const violations = [...a.violations, ...verdict.violations];
  if (!stable.ok) violations.push(stable.reason);
  const planner = a.planner || (w.planner
    ? { count: int(w.planner.count), digest: str(w.planner.digest) || null }
    : null);
  return {
    windows: a.windows + 1,
    planner,
    maxFinalInWindow: Math.max(int(a.maxFinalInWindow) ?? 0, int(w.finalRecipients) ?? 0),
    violations: [...new Set(violations)],
    complete: w.done === true,
  };
}

/**
 * 走査全体の結論。
 *
 * ⚠️ **読み切っていなければ「効いている」とは言わない**（部分を全体として扱わない）。
 */
export function finalizeWindowRun(acc) {
  const a = acc && typeof acc === 'object' ? acc : emptyWindowRun();
  const clean = a.violations.length === 0;
  return {
    windows: a.windows,
    planner: a.planner,
    /** 1 窓で見えた最大人数（**合計ではない**） */
    maxFinalInWindow: a.maxFinalInWindow,
    violations: a.violations,
    complete: a.complete === true,
    /** 許可リストが効いていると言えるか */
    allowlistHolds: clean && a.complete === true,
    note: clean && a.complete === true
      ? '全窓で許可リストの外へ出ていません（人数は足していません。集合の外へ出ていないかだけを見ています）。'
      : (clean
        ? '**まだ読み切っていません**。nextOffset / nextLedgerOffset が両方 null になるまで続けてください。'
        : '**条件を満たしていません**。追加実行せず、原因を確かめてください。'),
  };
}

export default judgeWindow;
