/**
 * sharedCheckerSupport.mjs — checkShared*.mjs 群の共通土台（CLI/server 専用）
 *
 * ⚠️ ブラウザ／クライアントバンドルへ import しないこと。
 *
 * 提供するもの:
 *   - 一時エラーの分類と専用 exit code（EXIT_TRANSIENT = 2）
 *
 * ## なぜ exit code を分けるのか
 *
 * 従来 checker は「token 未設定」も「レート制限」も一律 exit 1 を返していた。
 * 呼び出し側（verify-archive-sync.yml 等）はこれを区別できず、
 * shared への GET が1回 403 になっただけで workflow 全体が failure になり、
 * failed メールが飛んでいた（2026-08-09 の archive-sync と同じ構造）。
 *
 *   exit 0 … 判定できた（見つかった / 認証済み404=未投入）
 *   exit 2 … 判定できなかったが一時的な理由（rate limit / timeout / 5xx）。
 *            呼び出し側はその日をスキップしてよい。次回実行で再試行される。
 *   exit 1 … 判定できず、かつ運用者が手を入れないと直らない
 *            （token 未設定 / 401 / 権限不足 / 契約違反）。従来どおり fatal。
 *
 * exit 2 も非ゼロなので、`if ! cmd` / `cmd || exit 1` のように
 * 成否だけを見る既存の呼び出し側の挙動は変わらない（後方互換）。
 */
import { SharedFetchError, SHARED_FETCH_CODES } from './sharedFetch.mjs';

/** 一時エラー時の exit code。0 でも 1 でもない値で「判定不能だが一時的」を表す。 */
export const EXIT_TRANSIENT = 2;

/**
 * 一時的な取得失敗（枠の回復や相手側の復旧を待てば直るもの）。
 * sharedFetch の RETRYABLE_CODES と同じ分類を使う。
 */
const TRANSIENT_CODES = new Set([
  SHARED_FETCH_CODES.RATE_LIMITED,
  SHARED_FETCH_CODES.TIMEOUT,
  SHARED_FETCH_CODES.SERVER_ERROR,
]);

/**
 * @param {unknown} error
 * @returns {boolean} 一時エラーなら true
 */
export function isTransientSharedFetchError(error) {
  return error instanceof SharedFetchError && TRANSIENT_CODES.has(error.code);
}

/**
 * checker の直接実行時に使う共通 exit ハンドラ。
 * message のみ stderr へ出す（token / response body は出さない）。
 * @param {unknown} error
 * @param {{exit?: (code: number) => void, write?: (s: string) => void}} [io]
 */
export function exitWithSharedFetchError(error, io = {}) {
  const write = io.write ?? ((s) => process.stderr.write(s));
  const exit = io.exit ?? ((c) => process.exit(c));
  const transient = isTransientSharedFetchError(error);
  write(`${error?.message ?? String(error)}\n`);
  if (transient) write(`TRANSIENT: 一時エラーのため判定不能（次回実行で再試行）\n`);
  exit(transient ? EXIT_TRANSIENT : 1);
}
