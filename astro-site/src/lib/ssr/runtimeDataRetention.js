/**
 * runtimeDataRetention.js — SSR 関数が **実行時に読む** データの保持ポリシー（純粋・I/O なし）
 *
 * ── なぜ要るか（2026-08-08 の退行）────────────────────────────────
 * 有料ページを SSR 化した（#257 / #259 / #261）ことで、**ビルド時に読んでいた**
 * `src/data` 配下を **リクエスト時に読む**ようになった。ところが
 * `prune-ssr-function-data.mjs` は SSR 関数バンドルから重いサブツリーを
 * **ディレクトリごと削除**していたため、認可を通った有料会員に
 * 「本日の予想データがありません」が出る状態になっていた
 * （500 にはならず静かに空表示になるので外形監視では検出できない）。
 *
 * ── 方針 ────────────────────────────────────────────────────────
 * 「全部消す」か「全部残す」かの二択をやめ、**各 loader が実際に開くファイル集合**だけを残す。
 *   - 保持は **日付単位**。`{date}-{VENUE}.json` のように 1 開催日が複数会場へ分かれるものは
 *     **その日のファイルを全部**残す（会場ごとに 1 ファイル必要なので「最新 1 ファイル」では足りない）
 *   - 残す日数は `KEEP_DATES`。**最新 1 日だけに決め打ちしない**（取込タイミングのズレや
 *     loader の fallback で 1 つ前の開催日を読む場合があるため）
 *   - データ schema・consumer contract・自動 import フローは**一切変更しない**。
 *     消すのは「SSR 関数バンドルに同梱された過去分のコピー」だけで、リポジトリの
 *     `src/data` 本体は無傷。
 */

/** SSR 関数へ残す開催日数（新しい順）。1 だと取込ズレで空表示になるため 2 以上にする。 */
export const KEEP_DATES = 3;

/**
 * 実行時に読むサブツリーと、ファイル名から**開催日**を取り出す規則。
 *
 * `datePattern` の 1 番目のキャプチャが `YYYY-MM-DD`。
 * 同じ日付を持つファイルは**まとめて残す**（＝複数会場・複数レースに対応）。
 */
export const RUNTIME_SUBTREES = Object.freeze([
  {
    // premium-sanrenpuku-jra / premium-prediction/jra が最新日を選んで読む本体データ。
    // 1 ファイルに venues[] が入るので日付あたり 1 ファイル。
    sub: 'predictions/jra',
    datePattern: /^(\d{4}-\d{2}-\d{2})\.json$/,
    readers: ['loadJraVenuesForDisplay', 'premium-prediction/jra.astro'],
  },
  {
    // loadFeatureScores('jra', date, venueCode) — **開催会場ごとに 1 ファイル**。
    sub: 'featureScores/jra',
    datePattern: /^(\d{4}-\d{2}-\d{2})-[A-Z]+\.json$/,
    readers: ['loadFeatureScores'],
  },
  {
    // loadFeatureScores('nankan', date, venueCode) — premium-prediction/nankan などが読む。
    sub: 'featureScores/nankan',
    datePattern: /^(\d{4}-\d{2}-\d{2})-[A-Z]+\.json$/,
    readers: ['loadFeatureScores'],
  },
  {
    // loadHorseHistoriesForVenue(date, venueCode) — premium-prediction/jra の過去走注入。
    sub: 'horseHistories/jra',
    datePattern: /^(\d{4}-\d{2}-\d{2})-[A-Z]+\.json$/,
    readers: ['loadHorseHistoriesJra'],
  },
  {
    // loadHorseStatsNankan — light-predictions が読む。**日付 × 会場 × レース**で分かれる。
    sub: 'horseStats/nankan',
    datePattern: /^(\d{4}-\d{2}-\d{2})-[A-Z]+-R\d{2}\.json$/,
    readers: ['loadHorseStatsNankan'],
  },
]);

/**
 * 実行時に**読まない**ので丸ごと削除してよいサブツリー。
 * ここへ足す前に「SSR ページから fs で読んでいないか」を必ず確認すること。
 */
export const BUILD_ONLY_SUBTREES = Object.freeze([
  'computer',      // 取込スクリプト専用
  'horseStats/jra', // 実行時 loader なし（存在すれば削除）
]);

/**
 * ファイル名の集合から「残す日付」を決める。
 *
 * @param {string[]} fileNames  対象サブツリー配下の**ファイル名のみ**（パス不可）
 * @param {RegExp} datePattern  1 番目のキャプチャが YYYY-MM-DD
 * @param {number} keepDates    残す開催日数
 * @returns {string[]} 新しい順の日付（重複なし）
 */
export function pickKeepDates(fileNames, datePattern, keepDates = KEEP_DATES) {
  const dates = new Set();
  for (const name of fileNames || []) {
    const m = datePattern.exec(String(name));
    if (m) dates.add(m[1]);
  }
  return [...dates].sort().reverse().slice(0, Math.max(1, keepDates));
}

/**
 * 1 ファイルを残すかどうか。**日付を取り出せないファイルは残す**（判断できないものを消さない）。
 *
 * @param {string} fileName
 * @param {RegExp} datePattern
 * @param {Set<string>|string[]} keepDates
 */
export function shouldKeepFile(fileName, datePattern, keepDates) {
  const m = datePattern.exec(String(fileName));
  if (!m) return true; // 命名規則から外れるものは触らない（fail safe）
  const set = keepDates instanceof Set ? keepDates : new Set(keepDates || []);
  return set.has(m[1]);
}
