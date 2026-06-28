/**
 * checkSharedDailyFile.mjs — shared の統合 daily ファイル存在確認（認証付き / sharedFetch 再利用）
 *
 * keiba-data-shared private 化後も動くよう、匿名 raw/curl を廃し sharedFetch helper の
 * 認証付き Contents API で `{category}/{kind}/YYYY/MM/YYYY-MM-DD.json`（統合 daily ファイル）の
 * 存在・JSON・race数を確認する。契約（token必須・401/403/429/5xx fatal・404のみ未投入）は
 * helper と一元化し、workflow shell 側へ二重実装しない。
 *
 * JRA/南関 共通の統合 daily ファイル（results / predictions）を確認できる汎用 checker。
 * 南関 results の per-venue（会場別）確認は別 script `checkSharedNankanResults.mjs` を使う。
 * --category（jra|nankan）/ --kind（results|predictions）を受ける（既定: jra/results）。
 *
 * 使い方:
 *   node scripts/checkSharedDailyFile.mjs --date 2026-05-08
 *   node scripts/checkSharedDailyFile.mjs --date 2026-05-08 --category nankan --kind results
 *   node scripts/checkSharedDailyFile.mjs --date 2026-05-08 --category jra --kind predictions
 *
 * 直接実行時の stdout（機械可読・3 行のみ。token / response body は出力しない）:
 *   FOUND=true
 *   EXPECTED_VENUES=3      # data.races の race.venue ユニーク数（results のみ意味あり）
 *   EXPECTED_RACES=36      # data.races の件数（results のみ意味あり）
 *
 * exit code:
 *   0 … 存在を確定できた（200=存在 / 認証済み404=未投入）。404 は「未投入」であり error ではない
 *   1 … token 未設定 / 401 / 403 / 429 / 5xx / timeout / その他 fatal（＝確定不能。成功扱いしない）
 */
import { pathToFileURL } from 'node:url';
import { createSharedClient, resolveSharedToken } from './lib/sharedFetch.mjs';

const CATEGORIES = new Set(['jra', 'nankan']);
const KINDS = new Set(['results', 'predictions']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--category') args.category = argv[++i];
    else if (a === '--kind') args.kind = argv[++i];
  }
  return args;
}

/**
 * @returns {Promise<{found: boolean, expectedVenues: number, expectedRaces: number}>}
 *   404（未投入）は found:false を返す（throw しない）。
 *   token 未設定 / 401 / 403 / 429 / 5xx / timeout は throw（fatal・確定不能）。
 */
export async function checkSharedDailyFile({
  argv = process.argv.slice(2),
  env = process.env,
  client,
  resolveToken = resolveSharedToken,
  logger = console,
} = {}) {
  resolveToken({ env }); // token 未設定は取得前に TOKEN_MISSING で fatal（匿名 fallback 禁止）

  const args = parseArgs(argv);
  if (!args.date) {
    throw new Error('Usage: --date YYYY-MM-DD [--category jra|nankan] [--kind results|predictions]');
  }
  const category = args.category || 'jra';
  const kind = args.kind || 'results';
  if (!CATEGORIES.has(category)) throw new Error(`Invalid --category: ${category} (expected jra|nankan)`);
  if (!KINDS.has(kind)) throw new Error(`Invalid --kind: ${kind} (expected results|predictions)`);

  const c = client ?? createSharedClient({ env });
  const [y, m] = args.date.split('-');
  const sharedPath = `${category}/${kind}/${y}/${m}/${args.date}.json`;

  // required:false … 404 のみ null（未投入）。401/403/429/5xx/timeout/INVALID_* は throw（fatal）。
  const data = await c.fetchJson(sharedPath, { ref: 'main', required: false });
  if (data === null) {
    logger.error(`⏭️  ${category}/${kind} ${args.date}: not posted yet (authenticated 404)`); // 件数情報のみ・body非出力
    return { found: false, expectedVenues: 0, expectedRaces: 0 };
  }

  const races = Array.isArray(data.races) ? data.races : [];
  const expectedRaces = races.length;
  const venues = new Set(races.map((r) => r && r.venue).filter(Boolean));
  const expectedVenues = venues.size;
  logger.error(`✅ ${category}/${kind} ${args.date}: ${expectedRaces} races / ${expectedVenues} venues`);
  return { found: true, expectedVenues, expectedRaces };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  checkSharedDailyFile()
    .then(({ found, expectedVenues, expectedRaces }) => {
      // stdout は機械可読 3 行のみ（workflow が capture）。token / body は含めない。
      process.stdout.write(`FOUND=${found}\n`);
      process.stdout.write(`EXPECTED_VENUES=${expectedVenues}\n`);
      process.stdout.write(`EXPECTED_RACES=${expectedRaces}\n`);
    })
    .catch((e) => {
      console.error(e?.message ?? String(e)); // message のみ（token を含まない）
      process.exit(1);
    });
}
