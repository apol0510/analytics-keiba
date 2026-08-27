/**
 * prospectVerification.js — 移行後の検証を**合算して最終判定**する（純粋・I/O なし）
 *
 * ## 何のために要るか
 *
 * 検証は索引の窓（`prospectSequenceCheck`）に分割して呼ぶ。1 窓ずつでは
 * **全体を見たことにならない**ので、合算して「本当に全員を 1 回ずつ読めたか」を決める。
 *
 * ここが決めるのは 2 つで、**別のもの**として返す:
 *
 *   - `walk`                      … 走査そのものが筋の通ったものだったか
 *   - `customersDeletionAllowed`  … **Customers を消してよいか**
 *
 * ## ⚠️ `missing` は走査を止めないが、最終判定は通さない
 *
 * `missing` ＝ 索引にはあるが値を読めなかった件数（MGET が null）。
 *
 *   - **走査中**は続行してよい。窓は `scanned` で進むので、欠けても位置はずれない
 *   - **最終判定は fail closed**。`missing` が 1 件でもあれば、その人が
 *     「何通目まで送ったか」を**確かめられていない**。確かめられていない相手の
 *     Customers 行を消すと、**進行を復元する手段が消える**（送信履歴の唯一の根拠は
 *     prospect レコードなので、値が無ければ全員未送信＝**再送**になる）
 *
 * したがって `customersDeletionAllowed` は **`missing === 0` のときだけ** true。
 * 判定できない状態では**必ず false**（「わからない」を「消してよい」に倒さない）。
 */

/** 最終判定が通らなかった理由 */
export const VERIFY_FAIL = Object.freeze({
  /** 窓が 1 つも無い（走査していない）*/
  NO_WINDOWS: 'no_windows',
  /** 窓のどれかが失敗している */
  WINDOW_FAILED: 'window_failed',
  /** 窓ごとに索引の指紋が違う（途中で集合が変わった）*/
  DIGEST_MISMATCH: 'digest_mismatch',
  /** 窓ごとに索引の件数が違う */
  INDEX_SIZE_MISMATCH: 'index_size_mismatch',
  /** 窓が 0 から始まっていない / 飛んでいる / 重なっている */
  WINDOW_NOT_CONTIGUOUS: 'window_not_contiguous',
  /** 索引を最後まで走査していない */
  COVERAGE_INCOMPLETE: 'coverage_incomplete',
  /** ⚠️ 索引にはあるが**値を読めなかった**人が居る（最終判定は必ず落とす）*/
  VALUE_MISSING: 'value_missing',
  /** 読めた件数の辻褄が合わない（scanned - missing ≠ returned）*/
  COUNT_INCONSISTENT: 'count_inconsistent',
});

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : NaN);

/**
 * 窓の走査結果を合算して最終判定を出す。
 *
 * @param {{windows: Array<{offset, scanned, returned, missing, indexSize, digest, ok?}>,
 *          expectIndexSize?: number}} input
 * @returns {{
 *   walk: {ok: boolean},
 *   customersDeletionAllowed: boolean,
 *   reasons: string[],
 *   totals: {windows, indexSize, scanned, returned, missing, digest}
 * }}
 */
export function buildProspectVerificationVerdict({ windows, expectIndexSize } = {}) {
  const list = Array.isArray(windows) ? windows : [];
  const reasons = [];
  const totals = {
    windows: list.length, indexSize: null, scanned: 0, returned: 0, missing: 0, digest: null,
  };

  if (list.length === 0) {
    reasons.push(VERIFY_FAIL.NO_WINDOWS);
    return deny(reasons, totals);
  }

  const digests = new Set();
  const sizes = new Set();
  let cursor = 0;
  let contiguous = true;

  for (const w of list) {
    if (w && w.ok === false) reasons.push(VERIFY_FAIL.WINDOW_FAILED);
    const offset = int(w?.offset);
    const scanned = int(w?.scanned);
    const returned = int(w?.returned);
    const missing = int(w?.missing);
    const indexSize = int(w?.indexSize);

    if ([offset, scanned, returned, missing, indexSize].some((n) => !Number.isFinite(n) || n < 0)) {
      reasons.push(VERIFY_FAIL.COUNT_INCONSISTENT);
      contiguous = false;
      continue;
    }
    // ⚠️ 窓は前の窓の消費ぶんだけ進んでいなければならない（飛び・重なりを許さない）
    if (offset !== cursor) contiguous = false;
    // scanned - missing == returned でなければ数え方が壊れている
    if (scanned - missing !== returned) reasons.push(VERIFY_FAIL.COUNT_INCONSISTENT);

    digests.add(String(w?.digest ?? ''));
    sizes.add(indexSize);
    totals.scanned += scanned;
    totals.returned += returned;
    totals.missing += missing;
    cursor = offset + scanned;
  }

  totals.indexSize = sizes.size === 1 ? [...sizes][0] : null;
  totals.digest = digests.size === 1 ? [...digests][0] : null;

  if (digests.size !== 1 || !totals.digest) reasons.push(VERIFY_FAIL.DIGEST_MISMATCH);
  if (sizes.size !== 1) reasons.push(VERIFY_FAIL.INDEX_SIZE_MISMATCH);
  if (Number.isFinite(int(expectIndexSize)) && totals.indexSize !== int(expectIndexSize)) {
    reasons.push(VERIFY_FAIL.INDEX_SIZE_MISMATCH);
  }
  if (!contiguous) reasons.push(VERIFY_FAIL.WINDOW_NOT_CONTIGUOUS);
  // 索引を最後まで走査したか（走査した合計が索引全体と一致すること）
  if (totals.indexSize === null || totals.scanned !== totals.indexSize || totals.indexSize <= 0) {
    reasons.push(VERIFY_FAIL.COVERAGE_INCOMPLETE);
  }

  // 走査そのものは missing があっても成立しうる（窓は scanned で進むのでずれない）
  const walkOk = reasons.length === 0;

  // ⚠️ ここが本体: **値を読めなかった人が 1 人でも居たら最終判定は通さない**
  if (totals.missing > 0) reasons.push(VERIFY_FAIL.VALUE_MISSING);

  return {
    walk: { ok: walkOk },
    // ⚠️ **`missing === 0` のときだけ** true。判定できない状態は必ず false（fail closed）
    customersDeletionAllowed: walkOk && totals.missing === 0,
    reasons: [...new Set(reasons)],
    totals,
  };
}

/** 判定できないときの戻り（**必ず不許可**）*/
function deny(reasons, totals) {
  return {
    walk: { ok: false },
    customersDeletionAllowed: false,
    reasons: [...new Set(reasons)],
    totals,
  };
}

/**
 * 人が読む 1 行。**許可のときだけ**「消してよい」と書く。
 * それ以外は理由を出す（曖昧な言い方をしない）。
 */
export function describeVerdict(verdict) {
  if (!verdict || verdict.customersDeletionAllowed !== true) {
    const why = (verdict?.reasons || []).join(', ') || 'unknown';
    return `✖ Customers 削除は不可（${why}）`;
  }
  const t = verdict.totals;
  return `✅ Customers 削除の前提を満たす（索引 ${t.indexSize} / 読めた ${t.returned} / 値なし 0）`;
}
