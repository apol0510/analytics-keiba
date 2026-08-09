/**
 * sharedCheckerSupport.mjs — checkShared*.mjs 群の共通土台（CLI/server 専用）
 *
 * ⚠️ ブラウザ／クライアントバンドルへ import しないこと。
 *
 * 提供するもの:
 *   1. 一時エラーの分類と専用 exit code（EXIT_TRANSIENT = 2）
 *   2. 月ディレクトリ一覧による「存在しないファイルへの GET を撃たない」索引
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

/**
 * Contents API のディレクトリ一覧は 1000 件が上限でページングできない。
 * 到達した月は一覧を信用せず、従来どおり全ファイルへ GET する（取りこぼしを作らない）。
 */
const DIR_LISTING_MAX = 1000;

/**
 * 月ディレクトリのファイル名索引を作る。
 *
 * checker は 1 日ぶんを「会場ごとに GET して 404 か否か」で判定していたため、
 * 非開催日でも 1 日あたり 10〜20 GET を撃っていた。存在確認だけなら
 * 月ディレクトリ一覧 1 GET で足りるので、無いと分かっているファイルは撃たない。
 *
 * 判定は 3 値。'unknown' は「一覧が信用できないので個別に GET して確かめろ」の意味で、
 * 存在確認だけの呼び出し側が未検証で found と誤判定しないための逃げ道である。
 *
 * @param {{listDirectory: Function}} client sharedFetch のクライアント
 * @param {string} ref 参照 ref（通常 'main'）
 * @returns {{status: (dir: string, fileName: string) => Promise<'present'|'absent'|'unknown'>}}
 */
export function createMonthIndex(client, ref = 'main') {
  const cache = new Map();

  async function namesFor(dir) {
    if (cache.has(dir)) return cache.get(dir);

    const entries = await client.listDirectory(dir, { ref, required: false });

    let names;
    if (entries === null) {
      names = new Set(); // 月ディレクトリ自体が無い＝その月は空
    } else if (entries.length >= DIR_LISTING_MAX) {
      names = null; // 切り詰められている可能性 → 一覧を信用しない
    } else {
      names = new Set(entries.filter((e) => e.type === 'file').map((e) => e.name));
    }

    cache.set(dir, names);
    return names;
  }

  return {
    async status(dir, fileName) {
      const names = await namesFor(dir);
      if (names === null) return 'unknown';
      return names.has(fileName) ? 'present' : 'absent';
    },
  };
}

/**
 * import 系スクリプトの終端ハンドラ共通実装。
 *
 * 一時的な取得失敗（rate limit / timeout / 5xx）を **EX_TEMPFAIL=75** で返し、
 * それ以外（token / 認証 / 権限 / schema / 検証失敗）は fail-closed（既定 1）にする。
 *
 * なぜ 75 か: 多くのスクリプトが `exit 2` を「引数エラー」に使っており衝突するため、
 * 一時失敗を表す慣例コード EX_TEMPFAIL を採用した。
 * 75 も非ゼロなので、成否だけを見る既存の呼び出し側の挙動は変わらない。
 *
 * 呼び出し側（workflow）は 75 を「今は確定できない」として扱い、run を failure にしない。
 * sharedFetch 側で回復時刻ぶんの bounded retry を尽くした後にのみここへ到達する。
 *
 * @param {unknown} error
 * @param {{label?: string, fatalCode?: number, io?: {write?:Function, exit?:Function}}} [opts]
 */
export function exitDeferredOrFatal(error, opts = {}) {
  const { label = '', fatalCode = 1, io = {} } = opts;
  const write = io.write ?? ((s) => process.stderr.write(s));
  const exit = io.exit ?? ((c) => process.exit(c));
  const prefix = label ? `${label}: ` : '';

  if (isTransientSharedFetchError(error)) {
    write(`DEFERRED: ${prefix}${error.code} — 一時的に取得できないため中断（未書込・次回再試行）\n`);
    if (error.path) write(`  path: ${error.path}\n`);
    return exit(EXIT_DEFERRED);
  }
  write(`FATAL: ${prefix}${error?.message ?? String(error)}\n`);
  return exit(fatalCode);
}

/** 一時失敗を表す終了コード（EX_TEMPFAIL）。exit 2 は引数エラーで使用済みのため衝突を避ける。 */
export const EXIT_DEFERRED = 75;
