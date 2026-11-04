/**
 * GET /api/free-board/live.json — 無料 LIVE ボードの南関のレース単位の ✅/✗ と変更後の発走時刻（公開・読むだけ）
 * 返すのは { hits: {'会場|R': bool}, times: {'会場|R': ISO} } だけ。単一源は lib/freeBoardLive.js。
 * エッジに 60 秒キャッシュする（閲覧者が増えても公式へのアクセスは増えない）。
 */
export const prerender = false;

import { loadDay } from '../../../lib/acquisition/raceSource.js';
import { jstDate } from '../../../lib/ailab/aiLab.js';
import { jstToIso } from '../../../lib/freeLiveBoard.js';
import { loadLive } from '../../../lib/freeBoardLive.js';
import { makeRedisCmd } from '../../../lib/premiumPlus/premiumPlusFunnelServer.js';

export async function GET() {
  const now = Date.now();
  const date = jstDate(now);
  let view = { hits: {}, times: {} };
  try {
    const races = loadDay('nankan', date, { pastRaces: false }).flatMap((v) => v.races.map((r) => ({
      venueName: v.venueName,
      raceNumber: Number(r.raceInfo.raceNumber),
      startAt: jstToIso(date, r.raceInfo.startTime),
      lines: r.bettingLines?.umatan || [],
    }))).filter((r) => r.startAt);
    view = await loadLive({ redis: makeRedisCmd(process.env), races, date, nowMs: now });
  } catch (error) {
    console.error('[free-board/live] error:', error?.message || 'error');
  }
  return new Response(JSON.stringify({ date, ...view }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=0, must-revalidate', 'Netlify-CDN-Cache-Control': 'public, s-maxage=60' },
  });
}
