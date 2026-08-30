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
 *   - `maxAheadDays` を持つ spec は「ビルド日 + n 日」以内へ絞ってから新しい順に残す。
 *     先行投入された未来日だけで枠が埋まって**配信当日のファイルが消える**のを防ぐ
 *     （2026-08-30 / computer サブツリー）
 *   - データ schema・consumer contract・自動 import フローは**一切変更しない**。
 *     消すのは「SSR 関数バンドルに同梱された過去分のコピー」だけで、リポジトリの
 *     `src/data` 本体は無傷。
 */

/** SSR 関数へ残す開催日数（新しい順）。1 だと取込ズレで空表示になるため 2 以上にする。 */
export const KEEP_DATES = 3;

/**
 * 「ビルド日から何日先まで」を保持対象に含めるか（`maxAheadDays` を持つ spec のみ）。
 *
 * ⚠️ なぜ上限が要るか（2026-08-30 / computer サブツリー）:
 *   `pickKeepDates` は「**新しい順** に KEEP_DATES 日」を残す。JRA の computer JSON は
 *   先の開催日が先行して投入されることがあり、そのとき「新しい順 3 日」が
 *   **未来日だけ**で埋まり、**配信当日のファイルが削除される**。
 *   そこで computer は「ビルド日 + MAX_AHEAD_DAYS 以内」に絞ってから新しい順に残す。
 *   ビルドは前日夕方の自動取込で走る（＝ビルド日 +1 が配信当日）ので 1 で足りる。
 */
export const MAX_AHEAD_DAYS = 1;

/**
 * 'YYYY-MM-DD' に n 日足す（UTC 暦日で計算。呼び出し側が JST 日付文字列を渡す前提）。
 * 不正な入力は null。
 *
 * @param {string} date 'YYYY-MM-DD'
 * @param {number} days
 * @returns {string|null}
 */
export function addDaysIso(date, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return null;
  const n = Number(days);
  if (!Number.isFinite(n)) return null;
  const t = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

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
  {
    // loadComputerEntriesForDate(todayJst) — /dark-horse-picks/（SSR）が**当日分だけ**読む。
    // 2026-08-30 まで build-only 扱いだった。ページを SSR 化したので実行時サブツリーへ移動。
    sub: 'computer/jra',
    datePattern: /^(\d{4}-\d{2}-\d{2})-[A-Z]+\.json$/,
    readers: ['loadComputerEntriesForDate', 'dark-horse-picks.astro'],
    maxAheadDays: MAX_AHEAD_DAYS,
  },
  {
    sub: 'computer/nankan',
    datePattern: /^(\d{4}-\d{2}-\d{2})-[A-Z]+\.json$/,
    readers: ['loadComputerEntriesForDate', 'dark-horse-picks.astro'],
    maxAheadDays: MAX_AHEAD_DAYS,
  },
]);

/**
 * 実行時に**読まない**ので丸ごと削除してよいサブツリー。
 * ここへ足す前に「SSR ページから fs で読んでいないか」を必ず確認すること。
 */
export const BUILD_ONLY_SUBTREES = Object.freeze([
  // ⚠️ 'computer' をここへ戻さないこと（2026-08-30）。
  //    /dark-horse-picks/ が SSR で当日分を実行時に読むようになったため、
  //    丸ごと削除すると「本日の穴馬候補はまだ公開されていません」しか出なくなる。
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
export function pickKeepDates(fileNames, datePattern, keepDates = KEEP_DATES, maxDate = null) {
  const dates = new Set();
  for (const name of fileNames || []) {
    const m = datePattern.exec(String(name));
    if (m) dates.add(m[1]);
  }
  let list = [...dates].sort().reverse();
  // 上限日が指定されていれば、それより先の日付は候補から外してから「新しい順」に切る。
  // これが無いと、先行投入された未来日だけで枠が埋まり配信当日のファイルが消える。
  if (typeof maxDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(maxDate)) {
    const capped = list.filter((d) => d <= maxDate);
    // 上限以下が 1 日も無い（＝未来日しか無い）ときは、間引きで 0 件にしないため
    // 従来どおり新しい順で残す（fail safe：消しすぎない）。
    if (capped.length > 0) list = capped;
  }
  return list.slice(0, Math.max(1, keepDates));
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
