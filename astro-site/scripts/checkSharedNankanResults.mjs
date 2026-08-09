/**
 * checkSharedNankanResults.mjs — 南関 results の per-venue 存在確認（認証付き / sharedFetch 再利用）
 *
 * keiba-data-shared private 化後も動くよう、匿名 raw/curl を廃し sharedFetch helper の
 * 認証付き Contents API で確認する。契約（token必須・401/403/429/5xx fatal・404のみ未投入）は
 * helper と一元化し、workflow shell 側へ二重実装しない。
 *
 * 使い方:
 *   node scripts/checkSharedNankanResults.mjs --date 2026-05-08 --venues OOI,FUN,KAW,URA
 *
 * 直接実行時の stdout（機械可読・2 行のみ。token / response body は出力しない）:
 *   FOUND_CODES=OOI FUN
 *   TOTAL_RACES=24
 *
 * exit code:
 *   0 … 全会場を確定できた（存在 or 認証済み404=未投入）。FOUND_CODES が空でも「正常な空」
 *   1 … token 未設定 / 401 / 403 / 429 / 5xx / timeout / その他 fatal（＝確定不能。成功扱いしない）
 */
import { pathToFileURL } from 'node:url';
import { createSharedClient, resolveSharedToken } from './lib/sharedFetch.mjs';
import { exitDeferredOrFatal } from './lib/sharedCheckerSupport.mjs';

const LABEL = 'checkSharedNankanResults.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--venues') args.venues = argv[++i];
  }
  return args;
}

/**
 * @returns {Promise<{foundCodes: string[], totalRaces: number}>}
 *   1 件でも認証/通信 fatal があれば throw（partial result は返さない）。
 */
export async function checkSharedNankanResults({
  argv = process.argv.slice(2),
  env = process.env,
  client,
  resolveToken = resolveSharedToken,
  logger = console,
} = {}) {
  resolveToken({ env }); // token 未設定は取得前に TOKEN_MISSING で fatal（匿名 fallback 禁止）

  const args = parseArgs(argv);
  if (!args.date) throw new Error('Usage: --date YYYY-MM-DD --venues OOI,FUN,KAW,URA');
  const venues = (args.venues || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const c = client ?? createSharedClient({ env });
  const [y, m] = args.date.split('-');

  const foundCodes = [];
  let totalRaces = 0;

  for (const code of venues) {
    const sharedPath = `nankan/results/${y}/${m}/${args.date}-${code}.json`;
    // required:false … 404 のみ null（未投入）。401/403/429/5xx/timeout/INVALID_* は throw（fatal）。
    const data = await c.fetchJson(sharedPath, { ref: 'main', required: false });
    if (data === null) {
      logger.error(`⏭️  ${code}: not posted yet (authenticated 404)`); // 件数情報のみ・body非出力
      continue;
    }
    const races = Array.isArray(data.races) ? data.races.length : 0;
    foundCodes.push(code);
    totalRaces += races;
    logger.error(`✅ ${code}: ${races} races`);
  }

  return { foundCodes, totalRaces };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  checkSharedNankanResults()
    .then(({ foundCodes, totalRaces }) => {
      // stdout は機械可読 2 行のみ（workflow が capture）。token / body は含めない。
      process.stdout.write(`FOUND_CODES=${foundCodes.join(' ')}\n`);
      process.stdout.write(`TOTAL_RACES=${totalRaces}\n`);
    })
    .catch((e) => {
      exitDeferredOrFatal(e, { label: LABEL });
    });
}
